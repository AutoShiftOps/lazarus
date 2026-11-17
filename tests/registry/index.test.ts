import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRegistry, type RedisLike } from "../../lib/registry";
import type { ServiceDefinition } from "../../lib/soap/types";

const TTL = 2_592_000;
const SECRET = "SECRET-token-9f8e7d6c5b4a-upstash.io";

type SetOptions = { ex: number; nx?: boolean };
type Call =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; options: SetOptions };

/** In-memory stand-in for Redis; never touches the network. */
class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  calls: Call[] = [];
  failWith: Error | undefined;
  /** Runs just before each set, to simulate a concurrent writer. */
  beforeSet: ((key: string, store: Map<string, string>) => void) | undefined;

  async get(key: string): Promise<unknown> {
    this.calls.push({ op: "get", key });
    if (this.failWith) throw this.failWith;
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, options: SetOptions): Promise<unknown> {
    this.calls.push({ op: "set", key, value, options });
    if (this.failWith) throw this.failWith;
    this.beforeSet?.(key, this.store);
    if (options.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  sets(): Extract<Call, { op: "set" }>[] {
    return this.calls.filter((c): c is Extract<Call, { op: "set" }> => c.op === "set");
  }
}

const def: ServiceDefinition = {
  name: "Calculator",
  wsdlUrl: "http://www.dneonline.com/calculator.asmx?WSDL",
  ports: [],
  warnings: [],
};

const urlKey = (url: string) =>
  `wsdl-url:${createHash("sha256").update(url).digest("hex")}`;

describe("registry.upsertService", () => {
  it("writes a new entry and the url pointer, created:true", async () => {
    const redis = new FakeRedis();
    const result = await createRegistry(redis).upsertService(def);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[A-Za-z0-9]{8}$/);

    const stored = JSON.parse(redis.store.get(`service:${result.id}`) ?? "null");
    expect(stored).toEqual({ ...def, id: result.id });
    expect(redis.store.get(urlKey(def.wsdlUrl))).toBe(result.id);
  });

  it("sets a 30-day TTL on both writes", async () => {
    const redis = new FakeRedis();
    const result = await createRegistry(redis).upsertService(def);
    if (!result.ok) throw new Error("expected ok");

    const sets = redis.sets();
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.key).sort()).toEqual(
      [`service:${result.id}`, urlKey(def.wsdlUrl)].sort(),
    );
    for (const s of sets) expect(s.options.ex).toBe(TTL);
  });

  it("dedups: same URL returns same id, created:false, no service write", async () => {
    const redis = new FakeRedis();
    const reg = createRegistry(redis);
    const first = await reg.upsertService(def);
    if (!first.ok) throw new Error("expected ok");

    redis.calls = [];
    const second = await reg.upsertService({ ...def, name: "Renamed" });
    expect(second).toEqual({ ok: true, id: first.id, created: false });
    expect(redis.sets()).toHaveLength(0);
  });

  it("handles the NX race: returns the winner's id, created:false, deletes nothing", async () => {
    const redis = new FakeRedis();
    redis.beforeSet = (key, store) => {
      if (key === urlKey(def.wsdlUrl)) store.set(key, "WinnerId1");
    };
    const result = await createRegistry(redis).upsertService(def);

    expect(result).toEqual({ ok: true, id: "WinnerId1", created: false });
    expect(redis.store.get(urlKey(def.wsdlUrl))).toBe("WinnerId1");
    expect(redis.calls.every((c) => c.op === "get" || c.op === "set")).toBe(true);
  });

  it("maps a Redis error to REGISTRY_UNAVAILABLE without leaking error text", async () => {
    const redis = new FakeRedis();
    redis.failWith = new Error(`connect ECONNREFUSED https://${SECRET}`);
    const result = await createRegistry(redis).upsertService(def);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_UNAVAILABLE");
    expect(result.error.message).toBe("The registry is temporarily unavailable.");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("maps a Redis error during the write phase to REGISTRY_UNAVAILABLE", async () => {
    const redis = new FakeRedis();
    redis.set = async () => {
      throw new Error(SECRET);
    };
    const result = await createRegistry(redis).upsertService(def);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGISTRY_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("registry.getService", () => {
  it("returns a stored service", async () => {
    const redis = new FakeRedis();
    const reg = createRegistry(redis);
    const up = await reg.upsertService(def);
    if (!up.ok) throw new Error("expected ok");

    const got = await reg.getService(up.id);
    expect(got).toEqual({ ok: true, value: { ...def, id: up.id } });
  });

  it("returns null for an unknown valid id", async () => {
    const got = await createRegistry(new FakeRedis()).getService("Abcd1234");
    expect(got).toEqual({ ok: true, value: null });
  });

  it.each([
    ["too short", "abc1234"],
    ["too long", "abcdefgh12345"],
    ["symbols", "abc!@#$%^&"],
    ["path-like", "../../etc/passwd"],
    ["key-injection", "abcd1234:x*"],
    ["empty", ""],
    ["whitespace", "abcd 1234"],
  ])("rejects invalid id (%s) without touching Redis", async (_label, id) => {
    const redis = new FakeRedis();
    const got = await createRegistry(redis).getService(id);
    expect(got).toEqual({ ok: true, value: null });
    expect(redis.calls).toHaveLength(0);
  });

  it("returns null for corrupted JSON", async () => {
    const redis = new FakeRedis();
    redis.store.set("service:Abcd1234", "{not json");
    const got = await createRegistry(redis).getService("Abcd1234");
    expect(got).toEqual({ ok: true, value: null });
  });

  it("returns null for JSON of the wrong shape", async () => {
    const redis = new FakeRedis();
    redis.store.set("service:Abcd1234", JSON.stringify({ name: 1 }));
    const got = await createRegistry(redis).getService("Abcd1234");
    expect(got).toEqual({ ok: true, value: null });
  });

  it("maps a Redis error to REGISTRY_UNAVAILABLE without leaking error text", async () => {
    const redis = new FakeRedis();
    redis.failWith = new Error(SECRET);
    const got = await createRegistry(redis).getService("Abcd1234");

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe("REGISTRY_UNAVAILABLE");
    expect(got.error.message).toBe("The registry is temporarily unavailable.");
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });
});
