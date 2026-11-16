// tests/soap/safefetch.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch, fetchWsdl } from "../../lib/soap/fetcher";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/ok") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<wsdl/>");
    } else if (path === "/404") {
      res.writeHead(404);
      res.end("nope");
    } else if (path === "/500") {
      res.writeHead(500);
      res.end("boom");
    } else if (path.startsWith("/hop/")) {
      const n = Number(path.slice(5));
      res.writeHead(302, { Location: n > 0 ? `/hop/${n - 1}` : "/ok" });
      res.end();
    } else if (path === "/to-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (path === "/big-cl") {
      res.writeHead(200, { "Content-Length": "2000" });
      res.end("x".repeat(2000));
    } else if (path === "/big-stream") {
      res.writeHead(200); // no Content-Length -> chunked
      res.write("x".repeat(600));
      res.write("x".repeat(600));
      res.end();
    } else if (path === "/hang") {
      // never respond
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const opts = { allowLoopback: true } as const;

describe("safeFetch against a local server", () => {
  it("returns the body on 200", async () => {
    const r = await safeFetch(`${base}/ok`, opts);
    expect(r).toEqual({ ok: true, xml: "<wsdl/>", finalUrl: `${base}/ok` });
  });

  it("fails on 404", async () => {
    const r = await safeFetch(`${base}/404`, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_FETCH_FAILED");
  });

  it("fails on 500", async () => {
    const r = await safeFetch(`${base}/500`, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_FETCH_FAILED");
  });

  it("follows redirects within the limit", async () => {
    const r = await safeFetch(`${base}/hop/2`, { ...opts, maxRedirects: 5 });
    expect(r.ok).toBe(true);
  });

  it("stops a 6-hop redirect chain at maxRedirects=5", async () => {
    const r = await safeFetch(`${base}/hop/5`, { ...opts, maxRedirects: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WSDL_FETCH_FAILED");
      expect(r.error.message).toMatch(/redirect/i);
    }
  });

  it("blocks a redirect to the metadata IP without contacting it", async () => {
    const spy = vi.spyOn(http, "request");
    try {
      const r = await safeFetch(`${base}/to-metadata`, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
      const hosts = spy.mock.calls.map((c) =>
        typeof c[0] === "string"
          ? new URL(c[0]).hostname
          : (c[0] as URL).hostname,
      );
      expect(hosts).toContain("127.0.0.1");
      expect(hosts).not.toContain("169.254.169.254");
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores allowLoopback when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const r = await safeFetch(`${base}/ok`, { allowLoopback: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a body over maxBytes via Content-Length", async () => {
    const r = await safeFetch(`${base}/big-cl`, { ...opts, maxBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_TOO_LARGE");
  });

  it("rejects a streamed body over maxBytes without Content-Length", async () => {
    const r = await safeFetch(`${base}/big-stream`, { ...opts, maxBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_TOO_LARGE");
  });

  it("times out when the server never responds", async () => {
    const r = await safeFetch(`${base}/hang`, { ...opts, timeoutMs: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
  });

  it("blocks loopback when allowLoopback is not set", async () => {
    const r = await safeFetch(`${base}/ok`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
  });
});

describe("fetchWsdl URL validation", () => {
  it.each(["ftp://example.com/x.wsdl", "file:///etc/passwd", "not a url"])(
    "rejects %s with INVALID_REQUEST",
    async (u) => {
      const r = await fetchWsdl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    },
  );
});
