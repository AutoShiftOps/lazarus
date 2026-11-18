// In-memory ApprovalsRedis for tests.
//
// eval() recognises the exact scripts exported by lib/safety/approvals.ts and runs a JS
// translation of each one. Every command runs synchronously inside one tick (atomic, like
// Redis); methods are async so callers can interleave. If a Lua script changes, change the
// matching branch here.
//
// Like the Upstash client, hgetall returns values JSON-deserialized when they parse.
// TTLs are recorded (see ttls) but not enforced; tests drive expiry through the injected clock.

import {
  CLAIM_SCRIPT,
  MARK_EXECUTED_SCRIPT,
  RESOLVE_SCRIPT,
  type ApprovalsRedis,
} from "../../lib/safety/approvals";

export interface FakeApprovalsRedis extends ApprovalsRedis {
  readonly ttls: Map<string, number>;
  readonly hashes: Map<string, Map<string, string>>;
  readonly lists: Map<string, string[]>;
}

export function createFakeApprovalsRedis(): FakeApprovalsRedis {
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();

  const hget = (key: string, field: string): string | undefined => hashes.get(key)?.get(field);

  function resolve(key: string, args: string[]): string {
    const st = hget(key, "status");
    if (st === undefined) return "not_found";
    if (st !== "pending") return "conflict";
    const exp = Number(hget(key, "expiresAtMs"));
    if (!Number.isFinite(exp) || Number(args[1]) >= exp) return "conflict";
    const h = hashes.get(key)!;
    h.set("status", args[0]);
    h.set("resolvedAt", args[2]);
    h.set("note", args[3]);
    return "ok";
  }

  function claim(key: string, args: string[]): number {
    if (hget(key, "status") !== "approved") return 0;
    const exp = Number(hget(key, "expiresAtMs"));
    if (!Number.isFinite(exp) || Number(args[0]) >= exp) return 0;
    const h = hashes.get(key)!;
    if (h.has("claimed")) return 0; // HSETNX
    h.set("claimed", "1");
    return 1;
  }

  function markExecuted(key: string): number {
    const h = hashes.get(key);
    if (!h) return 0;
    h.set("status", "executed");
    return 1;
  }

  return {
    ttls,
    hashes,
    lists,
    async hset(key, fields) {
      await Promise.resolve();
      const h = hashes.get(key) ?? new Map<string, string>();
      for (const [k, v] of Object.entries(fields)) h.set(k, String(v));
      hashes.set(key, h);
      return Object.keys(fields).length;
    },
    async hgetall(key) {
      await Promise.resolve();
      const h = hashes.get(key);
      if (!h) return null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of h) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          out[k] = v;
        }
      }
      return out;
    },
    async expire(key, seconds) {
      await Promise.resolve();
      ttls.set(key, seconds);
      return 1;
    },
    async eval(script, keys, args) {
      await Promise.resolve();
      if (script === RESOLVE_SCRIPT) return resolve(keys[0], args);
      if (script === CLAIM_SCRIPT) return claim(keys[0], args);
      if (script === MARK_EXECUTED_SCRIPT) return markExecuted(keys[0]);
      throw new Error("fake-approvals-redis: unknown script");
    },
    async lpush(key, ...elements) {
      await Promise.resolve();
      const l = lists.get(key) ?? [];
      for (const e of elements) l.unshift(e);
      lists.set(key, l);
      return l.length;
    },
    async ltrim(key, start, stop) {
      await Promise.resolve();
      const l = lists.get(key);
      if (l) lists.set(key, l.slice(start, stop + 1));
      return "OK";
    },
    async lrange(key, start, stop) {
      await Promise.resolve();
      return (lists.get(key) ?? []).slice(start, stop + 1);
    },
  };
}
