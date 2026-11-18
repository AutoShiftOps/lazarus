import { describe, expect, it } from "vitest";
import { createRegistry } from "../../lib/registry";
import { publicDefinition } from "../../lib/owner-token";
import type { Rule } from "../../lib/safety/types";
import type { ServiceDefinition } from "../../lib/soap/types";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";

const TTL = 2_592_000;
const ID = "AbCd1234";

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  operation: "CloseAccount",
  effect: "hold",
  reason: "needs a human",
  ...over,
});

function setup() {
  const redis = createFakeRegistryRedis();
  return { redis, reg: createRegistry(redis) };
}

describe("registry rules", () => {
  it("defaults to an empty list", async () => {
    const { reg } = setup();
    expect(await reg.getRules(ID)).toEqual({ ok: true, value: [] });
  });

  it("round-trips rules under rules:{id} with the service TTL", async () => {
    const { redis, reg } = setup();
    const rules = [rule("r1", { when: { field: "amount", op: "gt", value: 100 } }), rule("r2", { effect: "block" })];
    expect(await reg.putRules(ID, rules)).toEqual({ ok: true });
    expect(await reg.getRules(ID)).toEqual({ ok: true, value: rules });
    expect(redis.ttls.get(`rules:${ID}`)).toBe(TTL);
  });

  it("accepts 25 rules and rejects 26", async () => {
    const { reg } = setup();
    const make = (n: number) => Array.from({ length: n }, (_, i) => rule(`r${i}`));
    expect((await reg.putRules(ID, make(25))).ok).toBe(true);
    const r = await reg.putRules(ID, make(26));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects duplicate rule ids and stores nothing", async () => {
    const { redis, reg } = setup();
    const r = await reg.putRules(ID, [rule("same"), rule("same", { effect: "block" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_REQUEST");
      expect(r.error.message).toContain("same");
    }
    expect(redis.store.has(`rules:${ID}`)).toBe(false);
  });

  it("rejects an invalid rule with field errors, within 500 chars", async () => {
    const { reg } = setup();
    const r = await reg.putRules(ID, [{ id: "", operation: "X", effect: "maybe", reason: "r" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_REQUEST");
      expect(r.error.message).toContain("0.effect");
      expect(r.error.message.length).toBeLessThanOrEqual(500);
    }
  });

  it("caps a very long error message at 500 chars", async () => {
    const { reg } = setup();
    const bad = Array.from({ length: 25 }, () => ({ id: "", operation: "", effect: "x", reason: 1 }));
    const r = await reg.putRules(ID, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message.length).toBeLessThanOrEqual(500);
  });

  it.each([
    ["unparseable JSON", "{oops"],
    ["schema-invalid", JSON.stringify([{ id: "r", operation: "X", effect: "nope", reason: "" }])],
    ["not an array", JSON.stringify({ id: "r" })],
    ["duplicate ids", JSON.stringify([rule("d"), rule("d")])],
  ])("fails closed on corrupt stored rules (%s)", async (_name, stored) => {
    const { redis, reg } = setup();
    redis.store.set(`rules:${ID}`, stored);
    const r = await reg.getRules(ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REGISTRY_UNAVAILABLE");
  });

  it("returns REGISTRY_UNAVAILABLE on Redis errors without upstream text", async () => {
    const { redis, reg } = setup();
    redis.failWith = new Error("https://secret.upstash.io down");
    for (const r of [await reg.getRules(ID), await reg.putRules(ID, [])]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("REGISTRY_UNAVAILABLE");
        expect(r.error.message).not.toContain("upstash");
      }
    }
  });
});

describe("registry settings", () => {
  it("defaults to ghost:false", async () => {
    const { reg } = setup();
    expect(await reg.getSettings(ID)).toEqual({ ok: true, value: { ghost: false } });
  });

  it("round-trips settings under settings:{id} with the service TTL", async () => {
    const { redis, reg } = setup();
    expect(await reg.putSettings(ID, { ghost: true })).toEqual({ ok: true });
    expect(await reg.getSettings(ID)).toEqual({ ok: true, value: { ghost: true } });
    expect(redis.ttls.get(`settings:${ID}`)).toBe(TTL);
  });

  it("rejects extra keys and wrong types", async () => {
    const { redis, reg } = setup();
    for (const bad of [{ ghost: true, extra: 1 }, { ghost: "yes" }, {}, null]) {
      const r = await reg.putSettings(ID, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    }
    expect(redis.store.has(`settings:${ID}`)).toBe(false);
  });

  it.each([
    ["unparseable JSON", "{oops"],
    ["wrong type", JSON.stringify({ ghost: "no" })],
    ["extra key", JSON.stringify({ ghost: false, extra: 1 })],
  ])("fails closed on corrupt stored settings (%s)", async (_name, stored) => {
    const { redis, reg } = setup();
    redis.store.set(`settings:${ID}`, stored);
    const r = await reg.getSettings(ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REGISTRY_UNAVAILABLE");
  });

  it("returns REGISTRY_UNAVAILABLE on Redis errors", async () => {
    const { redis, reg } = setup();
    redis.failWith = new Error("boom");
    const g = await reg.getSettings(ID);
    const p = await reg.putSettings(ID, { ghost: true });
    for (const r of [g, p]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("REGISTRY_UNAVAILABLE");
    }
  });
});

describe("rules and settings leave the service record alone", () => {
  const def: ServiceDefinition = {
    name: "Calculator",
    wsdlUrl: "http://www.dneonline.com/calculator.asmx?WSDL",
    ports: [],
    warnings: [],
    ownerTokenHash: "a".repeat(64),
  };

  it("does not alter the service JSON, and publicDefinition still omits the hash", async () => {
    const { redis, reg } = setup();
    const up = await reg.upsertService(def);
    if (!up.ok) throw new Error("upsert failed");
    const before = redis.store.get(`service:${up.id}`);
    expect(before).toContain(def.ownerTokenHash);

    await reg.putRules(up.id, [rule("r1")]);
    await reg.putSettings(up.id, { ghost: true });

    expect(redis.store.get(`service:${up.id}`)).toBe(before);
    const got = await reg.getService(up.id);
    expect(got.ok).toBe(true);
    if (!got.ok || !got.value) throw new Error("service missing");
    expect(got.value.ownerTokenHash).toBe(def.ownerTokenHash);
    expect("ownerTokenHash" in publicDefinition(got.value)).toBe(false);
    expect(JSON.stringify(publicDefinition(got.value))).not.toContain(def.ownerTokenHash as string);
    expect(redis.store.get(`rules:${up.id}`)).not.toContain(def.ownerTokenHash as string);
  });
});
