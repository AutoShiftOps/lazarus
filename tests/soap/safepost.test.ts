// tests/soap/safepost.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safePost } from "../../lib/soap/fetcher";

type Seen = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const SECRET = "UPSTREAM-SECRET-TEXT";

let server: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;
let seen: Seen[] = [];
let otherSeen: Seen[] = [];

function record(into: () => Seen[], req: http.IncomingMessage, done: (b: Buffer) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    into().push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    done(body);
  });
}

function listen(s: http.Server): Promise<string> {
  return new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  other = http.createServer((req, res) => {
    record(() => otherSeen, req, () => {
      res.writeHead(200);
      res.end("other");
    });
  });
  otherBase = await listen(other);

  server = http.createServer((req, res) => {
    record(() => seen, req, (body) => {
      const path = req.url ?? "/";
      if (path === "/echo") {
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end("<ok/>");
      } else if (path === "/fault") {
        res.writeHead(500, { "Content-Type": "text/xml" });
        res.end("<Fault>boom</Fault>");
      } else if (path === "/size") {
        res.writeHead(200);
        res.end(String(body.length));
      } else if (path === "/redirect-other") {
        res.writeHead(302, { Location: `${otherBase}/landed` });
        res.end(SECRET);
      } else if (path === "/redirect-metadata") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end(SECRET);
      } else if (path === "/big-cl") {
        res.writeHead(200, { "Content-Length": "2000" });
        res.end(SECRET.padEnd(2000, "x"));
      } else if (path === "/big-stream") {
        res.writeHead(200); // chunked, no Content-Length
        res.write(SECRET.padEnd(600, "x"));
        res.write("x".repeat(600));
        res.end();
      } else if (path === "/hang") {
        // never respond
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  base = await listen(server);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  seen = [];
  otherSeen = [];
});

afterAll(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const loop = { allowLoopback: true } as const;
const soapHeaders = { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"urn:Do"' };

function targetHosts(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) =>
    typeof c[0] === "string" ? new URL(c[0]).hostname : (c[0] as URL).hostname,
  );
}

describe("safePost request delivery", () => {
  it("delivers the body byte-exact with Content-Type and SOAPAction", async () => {
    const body = '<a>héllo ✓ 😀 日本語</a>';
    const r = await safePost(`${base}/echo`, { body, headers: soapHeaders, ...loop });
    expect(r).toEqual({ ok: true, status: 200, body: "<ok/>" });
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.method).toBe("POST");
    expect(s.body.equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(s.headers["content-type"]).toBe("text/xml; charset=utf-8");
    expect(s.headers["soapaction"]).toBe('"urn:Do"');
    expect(Number(s.headers["content-length"])).toBe(Buffer.byteLength(body, "utf8"));
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
  });

  it("drops X-Evil and a Host override", async () => {
    await safePost(`${base}/echo`, {
      body: "<a/>",
      headers: { ...soapHeaders, "X-Evil": "1", Host: "evil.example" },
      ...loop,
    });
    const s = seen[0];
    expect(s.headers["x-evil"]).toBeUndefined();
    expect(s.headers.host).toBe(new URL(base).host);
  });

  it("matches allowed header names case-insensitively", async () => {
    await safePost(`${base}/echo`, {
      body: "<a/>",
      headers: { "content-type": "application/soap+xml", soapaction: "act" },
      ...loop,
    });
    expect(seen[0].headers["content-type"]).toBe("application/soap+xml");
    expect(seen[0].headers["soapaction"]).toBe("act");
  });

  it("returns HTTP 500 with an XML body as ok:true", async () => {
    const r = await safePost(`${base}/fault`, { body: "<a/>", headers: soapHeaders, ...loop });
    expect(r).toEqual({ ok: true, status: 500, body: "<Fault>boom</Fault>" });
  });
});

describe("safePost redirects", () => {
  it("does not follow a 302 to another local server", async () => {
    const r = await safePost(`${base}/redirect-other`, {
      body: "<a/>",
      headers: soapHeaders,
      ...loop,
    });
    expect(r.ok).toBe(false);
    expect(otherSeen).toHaveLength(0);
    if (!r.ok) expect(r.error.message).not.toContain(SECRET);
  });

  it("does not follow a redirect to the metadata IP", async () => {
    const spy = vi.spyOn(http, "request");
    const r = await safePost(`${base}/redirect-metadata`, {
      body: "<a/>",
      headers: soapHeaders,
      ...loop,
    });
    expect(r.ok).toBe(false);
    expect(targetHosts(spy)).not.toContain("169.254.169.254");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("safePost SSRF blocking", () => {
  it.each(["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/soap"])(
    "blocks %s without opening a request",
    async (u) => {
      const spy = vi.spyOn(http, "request");
      const r = await safePost(u, { body: "<a/>", headers: soapHeaders, ...loop });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("blocks a hostname that resolves to a private IP", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void,
    ) => {
      cb(null, [{ address: "10.0.0.5", family: 4 }]);
    }) as unknown as typeof dns.lookup);
    const r = await safePost("http://internal.example.test/soap", {
      body: "<a/>",
      headers: soapHeaders,
      ...loop,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
  });

  it("ignores allowLoopback in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(http, "request");
    const r = await safePost(`${base}/echo`, { body: "<a/>", headers: soapHeaders, ...loop });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    expect(spy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe("safePost size limits", () => {
  it("rejects a 262145-byte body with no socket", async () => {
    const spy = vi.spyOn(http, "request");
    const r = await safePost(`${base}/size`, {
      body: "a".repeat(262_145),
      headers: soapHeaders,
      ...loop,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a 262144-byte body", async () => {
    const r = await safePost(`${base}/size`, {
      body: "a".repeat(262_144),
      headers: soapHeaders,
      ...loop,
    });
    expect(r).toEqual({ ok: true, status: 200, body: "262144" });
  });

  it("fails cleanly when the declared Content-Length exceeds maxBytes", async () => {
    const r = await safePost(`${base}/big-cl`, {
      body: "<a/>",
      headers: soapHeaders,
      maxBytes: 1000,
      ...loop,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WSDL_TOO_LARGE");
      expect(r.error.message).not.toContain(SECRET);
    }
  });

  it("fails cleanly when a chunked response exceeds maxBytes", async () => {
    const r = await safePost(`${base}/big-stream`, {
      body: "<a/>",
      headers: soapHeaders,
      maxBytes: 1000,
      ...loop,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WSDL_TOO_LARGE");
      expect(r.error.message).not.toContain(SECRET);
    }
  });
});

describe("safePost timeout", () => {
  it("fails with TIMEOUT when the server never answers", async () => {
    const r = await safePost(`${base}/hang`, {
      body: "<a/>",
      headers: soapHeaders,
      timeoutMs: 50,
      ...loop,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMEOUT");
    server.closeAllConnections();
  });
});
