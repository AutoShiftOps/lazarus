// tests/soap/loopback-flag.test.ts
// LAZARUS_DEV_ALLOW_LOOPBACK: dev-only loopback override honoured by safeFetch.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "../../lib/soap/fetcher";
import { devAllowLoopback } from "../../lib/env";

const FLAG = "LAZARUS_DEV_ALLOW_LOOPBACK";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/to-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<wsdl/>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setEnv(flag: string | undefined, nodeEnv: string): void {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv(FLAG, flag);
}

describe("LAZARUS_DEV_ALLOW_LOOPBACK", () => {
  it("blocks 127.0.0.1 when the flag is unset", async () => {
    setEnv(undefined, "test");
    const spy = vi.spyOn(http, "request");
    const r = await safeFetch(`${base}/ok`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    expect(spy).not.toHaveBeenCalled();
  });

  it('reaches a local server when the flag is "1" and NODE_ENV is "test"', async () => {
    setEnv("1", "test");
    const r = await safeFetch(`${base}/ok`);
    expect(r).toEqual({ ok: true, xml: "<wsdl/>", finalUrl: `${base}/ok` });
  });

  it('blocks 127.0.0.1 when the flag is "1" and NODE_ENV is "production"', async () => {
    setEnv("1", "production");
    const spy = vi.spyOn(http, "request");
    const r = await safeFetch(`${base}/ok`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    "http://[fc00::1]/",
  ])("keeps %s blocked with the flag on", async (url) => {
    setEnv("1", "test");
    const spy = vi.spyOn(http, "request");
    const r = await safeFetch(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["0", "false", "yes", ""])(
    'devAllowLoopback() is false for flag value "%s"',
    (value) => {
      setEnv(value, "test");
      expect(devAllowLoopback()).toBe(false);
    },
  );

  it("devAllowLoopback() is true for \"1\" in test and false in production", () => {
    setEnv("1", "test");
    expect(devAllowLoopback()).toBe(true);
    setEnv("1", "production");
    expect(devAllowLoopback()).toBe(false);
  });

  it("blocks a redirect from the local server to the metadata IP", async () => {
    setEnv("1", "test");
    const spy = vi.spyOn(http, "request");
    const r = await safeFetch(`${base}/to-metadata`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SSRF_BLOCKED");
    // Only the local hop opened a request; the metadata hop never did.
    const hosts = spy.mock.calls.map((c) => (c[0] instanceof URL ? c[0].hostname : String(c[0])));
    expect(hosts).toEqual(["127.0.0.1"]);
  });
});
