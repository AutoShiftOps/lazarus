import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/demo/route";
import { bootstrapDemo, type DemoDeps } from "../../lib/demo";
import { wsdlHttp } from "../../lib/gravewood/http";
import { createStore, type GwRedis } from "../../lib/gravewood/store";
import { createRegistry } from "../../lib/registry";
import { summonFromBody, type SummonResponse } from "../../lib/summon";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";

const HOST = "demo.lazarus.test";
const ORIGIN = `https://${HOST}`;
const SANDBOX_ID = "AbCdEf123456";
const TOKEN = "tok-secret-value";

function okSummon(): SummonResponse {
  return {
    status: 200,
    body: { id: "svc12345", name: "Gravewood", operations: [], ownerToken: TOKEN, mcpUrl: `${ORIGIN}/api/mcp/svc12345` },
  };
}

type Harness = {
  deps: DemoDeps;
  clock: { ms: number };
  summon: ReturnType<typeof vi.fn>;
  createSandbox: ReturnType<typeof vi.fn>;
  redis: ReturnType<typeof createFakeRateRedis>;
};

function harness(over: Partial<DemoDeps> = {}): Harness {
  const clock = { ms: 1_000_000 };
  const redis = createFakeRateRedis(() => clock.ms);
  const summon = vi.fn<DemoDeps["summon"]>(async () => okSummon());
  const createSandbox = vi.fn(async () => ({ id: SANDBOX_ID }));
  const deps: DemoDeps = { createSandbox, summon, rateRedis: redis, origin: ORIGIN, ...over };
  return { deps, clock, summon, createSandbox, redis };
}

const savedHost = process.env.LAZARUS_GRAVEWOOD_HOST;
beforeEach(() => {
  process.env.LAZARUS_GRAVEWOOD_HOST = HOST;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedHost === undefined) delete process.env.LAZARUS_GRAVEWOOD_HOST;
  else process.env.LAZARUS_GRAVEWOOD_HOST = savedHost;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bootstrapDemo", () => {
  it("returns serviceId, ownerToken and sandboxId, summoning the sandbox WSDL URL", async () => {
    const h = harness();
    const res = await bootstrapDemo(h.deps, "1.2.3.4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serviceId: "svc12345", ownerToken: TOKEN, sandboxId: SANDBOX_ID });
    expect(h.summon).toHaveBeenCalledTimes(1);
    const [raw, origin] = h.summon.mock.calls[0] as [string, string];
    expect(JSON.parse(raw)).toEqual({ wsdlUrl: `${ORIGIN}/api/gravewood/${SANDBOX_ID}/wsdl` });
    expect(origin).toBe(ORIGIN);
  });

  it("never exposes ownerTokenHash or extra summon fields", async () => {
    const h = harness({
      summon: async () => ({
        status: 200,
        body: { id: "svc12345", ownerToken: TOKEN, ownerTokenHash: "a".repeat(64), mcpUrl: "x" },
      }),
    });
    const text = await (await bootstrapDemo(h.deps, "1.2.3.4")).text();
    expect(text).not.toContain("ownerTokenHash");
    expect(text).not.toContain("a".repeat(64));
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["ownerToken", "sandboxId", "serviceId"]);
  });

  it("limits each IP to 10 per minute, then allows again after the window", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) expect((await bootstrapDemo(h.deps, "9.9.9.9")).status).toBe(200);
    const blocked = await bootstrapDemo(h.deps, "9.9.9.9");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "The spirits are tired. Please wait a little and try again.",
      code: "RATE_LIMITED",
    });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(h.summon).toHaveBeenCalledTimes(10);

    expect((await bootstrapDemo(h.deps, "8.8.8.8")).status).toBe(200); // another IP is unaffected
    h.clock.ms += 61_000;
    expect((await bootstrapDemo(h.deps, "9.9.9.9")).status).toBe(200);
  });

  it("limits all clients together to 500 per hour", async () => {
    const h = harness();
    for (let i = 0; i < 500; i++) {
      // 50 distinct IPs x 10 stays under the per-IP limit.
      const res = await bootstrapDemo(h.deps, `10.0.0.${i % 50}`);
      expect(res.status).toBe(200);
      if (i % 10 === 9) h.clock.ms += 61_000; // roll the per-IP window, not the hourly one
    }
    const blocked = await bootstrapDemo(h.deps, "10.9.9.9");
    expect(blocked.status).toBe(429);
    expect((await blocked.json() as { code: string }).code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(h.summon).toHaveBeenCalledTimes(500);

    h.clock.ms += 3600 * 1000;
    expect((await bootstrapDemo(h.deps, "10.9.9.9")).status).toBe(200);
  });

  it("fails closed with a fixed 503 when the limiter fails", async () => {
    const h = harness();
    h.redis.failWith = new Error("redis exploded at https://secret.upstash.io");
    const res = await bootstrapDemo(h.deps, "1.2.3.4");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The demo is not available right now.", code: "UNAVAILABLE" });
    expect(text).not.toContain("upstash");
    expect(h.createSandbox).not.toHaveBeenCalled();
    expect(h.summon).not.toHaveBeenCalled();
  });

  it("refuses without summoning when the sandbox URL is not on the demo host", async () => {
    const h = harness({ origin: "https://evil.example" });
    const res = await bootstrapDemo(h.deps, "1.2.3.4");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The demo is not available right now.", code: "UNAVAILABLE" });
    expect(h.summon).not.toHaveBeenCalled();
  });

  it("refuses without summoning when no demo host is configured", async () => {
    delete process.env.LAZARUS_GRAVEWOOD_HOST;
    const h = harness();
    expect((await bootstrapDemo(h.deps, "1.2.3.4")).status).toBe(503);
    expect(h.summon).not.toHaveBeenCalled();
  });

  it("maps a summon failure to a fixed body that leaks no summon text", async () => {
    const leak = "ECONNREFUSED 10.0.0.5:6379 at /app/node_modules/x.js";
    const h = harness({ summon: async () => ({ status: 502, body: { error: leak, code: "WSDL_FETCH_FAILED" } }) });
    const res = await bootstrapDemo(h.deps, "1.2.3.4");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "The spirits could not be raised. Please try again in a moment.",
      code: "SUMMON_FAILED",
    });
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("maps a summon 503 to the fixed 503, and a 200 without a token to 502", async () => {
    const a = harness({ summon: async () => ({ status: 503, body: { error: "registry down at redis://x", code: "REGISTRY_UNAVAILABLE" } }) });
    const resA = await bootstrapDemo(a.deps, "1.2.3.4");
    expect(resA.status).toBe(503);
    expect(await resA.text()).not.toContain("redis://");

    const b = harness({ summon: async () => ({ status: 200, body: { id: "svc12345" } }) });
    expect((await bootstrapDemo(b.deps, "1.2.3.4")).status).toBe(502);
  });

  it("maps a throwing summon or sandbox creation to the fixed 503", async () => {
    const a = harness({ summon: async () => { throw new Error("boom secret"); } });
    const resA = await bootstrapDemo(a.deps, "1.2.3.4");
    expect(resA.status).toBe(503);
    expect(await resA.text()).not.toContain("secret");

    const b = harness({ createSandbox: async () => { throw new Error("boom secret"); } });
    const resB = await bootstrapDemo(b.deps, "1.2.3.4");
    expect(resB.status).toBe(503);
    expect(b.summon).not.toHaveBeenCalled();
  });
});

describe("app/api/demo/route", () => {
  it("exports maxDuration 60 and no runtime", () => {
    expect(route.maxDuration).toBe(60);
    expect("runtime" in route).toBe(false);
  });

  it("answers 405 with Allow: POST for every non-POST method", async () => {
    for (const handler of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect((await res.json() as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("never reads the request body, even a huge one", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const request = new Request(`${ORIGIN}/api/demo`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await route.POST(request);
    expect(res.status).toBe(503); // unconfigured env in tests: fixed body
    expect(await res.json()).toEqual({ error: "The demo is not available right now.", code: "UNAVAILABLE" });
    expect(request.bodyUsed).toBe(false);
    // The Request constructor prefetches one chunk; a handler that read the body would pull until done.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("ignores the body in bootstrapDemo: the summoned URL never depends on client input", async () => {
    // bootstrapDemo has no request parameter at all; the summon body is derived only from origin + sandbox id.
    const h = harness();
    await bootstrapDemo(h.deps, "1.2.3.4");
    expect(h.summon.mock.calls[0]?.[0]).toBe(JSON.stringify({ wsdlUrl: `${ORIGIN}/api/gravewood/${SANDBOX_ID}/wsdl` }));
  });
});

describe("integration: real Gravewood store and handler, real summon pipeline", () => {
  /** In-memory GwRedis (never networked). */
  function memoryGwRedis(): GwRedis {
    const data = new Map<string, string>();
    const counts = new Map<string, number>();
    return {
      async get(k) { return data.get(k) ?? null; },
      async set(k, v) { data.set(k, v); return "OK"; },
      async incr(k) { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n; },
      async expire() { return 1; },
      async ttl() { return 60; },
      async compareAndSet(k, expected, value) {
        const cur = data.get(k);
        if (cur === undefined) return false;
        if ((JSON.parse(cur) as { version: number }).version !== expected) return false;
        data.set(k, value);
        return true;
      },
    };
  }

  it("raises a Gravewood sandbox into a stored service and returns a usable token", async () => {
    const store = createStore(memoryGwRedis());
    const registryRedis = createFakeRegistryRedis();
    const registry = createRegistry(registryRedis);
    const fetched: string[] = [];

    const deps: DemoDeps = {
      createSandbox: () => store.createSandbox(),
      summon: (raw, origin) =>
        summonFromBody(raw, origin, {
          // The only substitution: serve the URL from the real handler instead of the network.
          fetchWsdl: async (url) => {
            fetched.push(url);
            const m = /\/api\/gravewood\/([A-Za-z0-9]+)\/wsdl$/.exec(new URL(url).pathname);
            const r = await wsdlHttp(m?.[1] ?? "", new URL(url).origin, { store });
            if (r.status !== 200) throw new Error("wsdl not served");
            return { ok: true, xml: r.body, finalUrl: url };
          },
          upsertService: (def) => registry.upsertService(def),
        }),
      rateRedis: createFakeRateRedis(() => 0),
      origin: ORIGIN,
    };

    const res = await bootstrapDemo(deps, "1.2.3.4");
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as { serviceId: string; ownerToken: string; sandboxId: string };
    expect(fetched).toEqual([`${ORIGIN}/api/gravewood/${body.sandboxId}/wsdl`]);
    expect(body.ownerToken.length).toBeGreaterThan(16);
    expect(text).not.toContain("ownerTokenHash");

    const stored = await registry.getService(body.serviceId);
    expect(stored.ok && stored.value !== null).toBe(true);
    if (stored.ok && stored.value) {
      expect(stored.value.wsdlUrl).toBe(fetched[0]);
      expect(stored.value.ports.flatMap((p) => p.operations).length).toBeGreaterThan(0);
      expect(stored.value.ownerTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(text).not.toContain(stored.value.ownerTokenHash ?? "never");
    }
  });
});
