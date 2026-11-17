import { describe, expect, it, vi } from "vitest";
import { hit } from "../../lib/rate-limit";
import { seedState } from "../../lib/gravewood/seed";
import { createStore, type GwRedis } from "../../lib/gravewood/store";
import type { BankState } from "../../lib/gravewood/types";

/** In-memory Redis with a controllable clock that applies TTLs. Never networked. */
class FakeRedis implements GwRedis {
  nowMs = 1_000_000;
  data = new Map<string, { value: string; expiresAt: number | null }>();
  getCalls: string[] = [];
  /** Runs before each compareAndSet to simulate a concurrent writer. */
  beforeCas: ((key: string) => void) | undefined;
  failWith: Error | undefined;

  advance(sec: number) {
    this.nowMs += sec * 1000;
  }

  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.nowMs) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private check() {
    if (this.failWith) throw this.failWith;
  }

  async get(key: string) {
    this.getCalls.push(key);
    this.check();
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, opts: { ex: number }) {
    this.check();
    this.data.set(key, { value, expiresAt: this.nowMs + opts.ex * 1000 });
    return "OK";
  }
  async compareAndSet(key: string, expected: number, value: string, ttl: number) {
    this.check();
    this.beforeCas?.(key);
    const e = this.live(key);
    if (!e) return false;
    if ((JSON.parse(e.value) as { version: number }).version !== expected) return false;
    this.data.set(key, { value, expiresAt: this.nowMs + ttl * 1000 });
    return true;
  }
  async incr(key: string) {
    this.check();
    const e = this.live(key);
    const n = (e ? Number(e.value) : 0) + 1;
    this.data.set(key, { value: String(n), expiresAt: e ? e.expiresAt : null });
    return n;
  }
  async expire(key: string, sec: number) {
    const e = this.live(key);
    if (e) e.expiresAt = this.nowMs + sec * 1000;
    return e ? 1 : 0;
  }
  async ttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - this.nowMs) / 1000);
  }
}

function setup() {
  const redis = new FakeRedis();
  const store = createStore(redis, { now: () => redis.nowMs });
  return { redis, store };
}

/** Bumps the version, as the real handler does on a change. */
function bump(s: BankState): BankState {
  return { ...s, version: s.version + 1, nextConfirmation: s.nextConfirmation + 1 };
}

describe("sandbox lifecycle", () => {
  it("creates a sandbox with a 12-char alphanumeric id and loads the seed", async () => {
    const { store } = setup();
    const { id, expiresAt } = await store.createSandbox();
    expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(expiresAt).toBe(new Date(1_000_000 + 3600_000).toISOString());
    expect(await store.loadState(id)).toEqual(seedState());
  });

  it("expires after 3601 seconds", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    redis.advance(3601);
    expect(await store.loadState(id)).toBeNull();
  });

  it("refreshes the TTL on write", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    redis.advance(3000);
    const r = await store.runOnSandbox(id, (s) => ({ state: bump(s), response: 1 }));
    expect(r.ok).toBe(true);
    redis.advance(3000);
    expect(await store.loadState(id)).not.toBeNull();
    redis.advance(601);
    expect(await store.loadState(id)).toBeNull();
  });

  it("reset restores the seed and bumps the version", async () => {
    const { store } = setup();
    const { id } = await store.createSandbox();
    await store.runOnSandbox(id, (s) => ({
      state: { ...bump(s), accounts: [] },
      response: null,
    }));
    expect(await store.resetSandbox(id)).toBe(true);
    expect(await store.loadState(id)).toEqual({ ...seedState(), version: 2 });
  });

  it("reset returns false for a missing sandbox", async () => {
    const { store } = setup();
    expect(await store.resetSandbox("AAAAAAAAAAAA")).toBe(false);
  });
});

describe("id validation and corrupt data", () => {
  it("never reaches Redis for invalid ids", async () => {
    const { redis, store } = setup();
    const spy = vi.spyOn(redis, "get");
    for (const bad of ["", "short", "AAAAAAAAAAAAA", "AAAAAAAAAAA!", "gw:../etc/pas", "AAAAAAAAAAA\n"]) {
      expect(await store.loadState(bad)).toBeNull();
      expect(await store.resetSandbox(bad)).toBe(false);
      expect(await store.runOnSandbox(bad, (s) => ({ state: s, response: 0 }))).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect((await store.allowCall(bad)).allowed).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(redis.data.size).toBe(0);
  });

  it("returns null for corrupted JSON and wrong shapes", async () => {
    const { redis, store } = setup();
    const id = "AAAAAAAAAAAA";
    for (const bad of [
      "{not json",
      "42",
      "[]",
      JSON.stringify({ accounts: [], txns: [], version: "1", nextConfirmation: 1 }),
      JSON.stringify({ accounts: {}, txns: [], version: 1, nextConfirmation: 1 }),
      JSON.stringify({ accounts: [], txns: [], version: 1 }),
    ]) {
      await redis.set(`gw:${id}`, bad, { ex: 60 });
      expect(await store.loadState(id)).toBeNull();
    }
  });
});

describe("runOnSandbox", () => {
  it("skips the write when fn returns the same state", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    const cas = vi.spyOn(redis, "compareAndSet");
    const set = vi.spyOn(redis, "set");
    const r = await store.runOnSandbox(id, (s) => ({ state: s, response: "x" }));
    expect(r).toEqual({ ok: true, response: "x" });
    expect(cas).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("persists a successful change", async () => {
    const { store } = setup();
    const { id } = await store.createSandbox();
    const r = await store.runOnSandbox(id, (s) => ({ state: bump(s), response: "done" }));
    expect(r).toEqual({ ok: true, response: "done" });
    expect((await store.loadState(id))?.version).toBe(1);
  });

  it("returns not-found for a missing sandbox", async () => {
    const { store } = setup();
    const r = await store.runOnSandbox("AAAAAAAAAAAA", (s) => ({ state: s, response: 0 }));
    expect(r).toEqual({ ok: false, reason: "not-found" });
  });

  it("retries after one forced conflict and succeeds", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    let conflicts = 1;
    redis.beforeCas = (key) => {
      if (conflicts-- > 0) {
        const cur = JSON.parse(redis.data.get(key)!.value) as BankState;
        redis.data.set(key, {
          value: JSON.stringify({ ...cur, version: cur.version + 1 }),
          expiresAt: redis.nowMs + 3600_000,
        });
      }
    };
    let calls = 0;
    const r = await store.runOnSandbox(id, (s) => {
      calls++;
      return { state: bump(s), response: "ok" };
    });
    expect(r).toEqual({ ok: true, response: "ok" });
    expect(calls).toBe(2);
    expect((await store.loadState(id))?.version).toBe(2);
  });

  it("gives up with conflict after three attempts", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    redis.beforeCas = (key) => {
      const cur = JSON.parse(redis.data.get(key)!.value) as BankState;
      redis.data.set(key, {
        value: JSON.stringify({ ...cur, version: cur.version + 1 }),
        expiresAt: redis.nowMs + 3600_000,
      });
    };
    let calls = 0;
    const r = await store.runOnSandbox(id, (s) => {
      calls++;
      return { state: bump(s), response: 0 };
    });
    expect(r).toEqual({ ok: false, reason: "conflict" });
    expect(calls).toBe(3);
  });

  it("rejects states over 64 KB and leaves the stored state unchanged", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    const before = redis.data.get(`gw:${id}`)!.value;
    const r = await store.runOnSandbox(id, (s) => ({
      state: { ...bump(s), accounts: [{ ...s.accounts[0], name: "x".repeat(70_000) }] },
      response: 0,
    }));
    expect(r).toEqual({ ok: false, reason: "too-large" });
    expect(redis.data.get(`gw:${id}`)!.value).toBe(before);
  });

  it("reports unavailable without leaking the Redis error", async () => {
    const { redis, store } = setup();
    const { id } = await store.createSandbox();
    redis.failWith = new Error("SECRET-token-upstash.io");
    const r = await store.runOnSandbox(id, (s) => ({ state: bump(s), response: 0 }));
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("rate limiting", () => {
  it("allows 10 hits then blocks with retryAfter >= 1", async () => {
    const redis = new FakeRedis();
    for (let i = 0; i < 10; i++) {
      expect((await hit(redis, "k", 10, 60)).allowed).toBe(true);
    }
    const blocked = await hit(redis, "k", 10, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("re-allows after the window expires", async () => {
    const redis = new FakeRedis();
    for (let i = 0; i < 11; i++) await hit(redis, "k", 10, 60);
    redis.advance(61);
    expect((await hit(redis, "k", 10, 60)).allowed).toBe(true);
  });

  it("gives a key with no TTL an expiry", async () => {
    const redis = new FakeRedis();
    redis.data.set("k", { value: "5", expiresAt: null });
    const r = await hit(redis, "k", 10, 60);
    expect(r.allowed).toBe(true);
    expect(await redis.ttl("k")).toBe(60);
  });

  it("allowCreate cleans hostile ip strings and limits to 10", async () => {
    const { redis, store } = setup();
    await store.allowCreate("1.2.3.4\r\nSET evil 1");
    await store.allowCreate("x".repeat(100));
    expect(redis.data.has("gw-create-rl:unknown")).toBe(true);
    expect(redis.data.get("gw-create-rl:unknown")!.value).toBe("2");
    for (let i = 0; i < 10; i++) await store.allowCreate("2001:db8::1");
    expect((await store.allowCreate("2001:db8::1")).allowed).toBe(false);
    expect([...redis.data.keys()].every((k) => /^gw-create-rl:[0-9a-fA-F:.]+$|unknown$/.test(k))).toBe(true);
  });

  it("allowCall limits a sandbox to 120 per window", async () => {
    const { store } = setup();
    const id = "AAAAAAAAAAAA";
    for (let i = 0; i < 120; i++) expect((await store.allowCall(id)).allowed).toBe(true);
    expect((await store.allowCall(id)).allowed).toBe(false);
  });
});
