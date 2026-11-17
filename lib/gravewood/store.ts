// lib/gravewood/store.ts
// Redis-backed sandbox storage for the Gravewood fake bank.
// No Redis or env access at import time.

import { Redis } from "@upstash/redis";
import { customAlphabet } from "nanoid";
import { getEnv } from "../env";
import { hit, type RateRedis, type RateResult } from "../rate-limit";
import { seedState } from "./seed";
import type { BankState } from "./types";

const TTL_SECONDS = 3600;
const MAX_STATE_BYTES = 65536;
const MAX_ATTEMPTS = 3;
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const newId = customAlphabet(ID_ALPHABET, 12);

/**
 * Atomic compare-and-set. KEYS[1] = key, ARGV[1] = expected version,
 * ARGV[2] = new JSON value, ARGV[3] = TTL in seconds.
 * Returns 0 when the key is missing or its stored `version` differs, else 1.
 */
const COMPARE_AND_SET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= 'table' then return 0 end
if tonumber(doc['version']) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

export type GwRedis = RateRedis & {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  /** Writes `value` only if the stored state's version equals `expectedVersion`. */
  compareAndSet(
    key: string,
    expectedVersion: number,
    value: string,
    ttlSec: number,
  ): Promise<boolean>;
};

export type RunFailure = "not-found" | "conflict" | "too-large" | "unavailable";
export type RunResult<T> =
  | { ok: true; response: T }
  | { ok: false; reason: RunFailure };

export interface GwStore {
  createSandbox(): Promise<{ id: string; expiresAt: string }>;
  loadState(id: string): Promise<BankState | null>;
  runOnSandbox<T>(
    id: string,
    fn: (s: BankState) => { state: BankState; response: T },
  ): Promise<RunResult<T>>;
  resetSandbox(id: string): Promise<boolean>;
  allowCreate(ip: string): Promise<RateResult>;
  allowCall(id: string): Promise<RateResult>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a stored value (string, or already-decoded object) and checks its shape. */
function toState(raw: unknown): BankState | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.accounts) ||
    !Array.isArray(value.txns) ||
    typeof value.version !== "number" ||
    typeof value.nextConfirmation !== "number"
  ) {
    return null;
  }
  return value as unknown as BankState;
}

function cleanIp(ip: string): string {
  return /^[0-9a-fA-F:.]{1,45}$/.test(ip) ? ip : "unknown";
}

const key = (id: string) => `gw:${id}`;

export function createStore(
  redis: GwRedis,
  opts: { now?: () => number } = {},
): GwStore {
  const now = opts.now ?? Date.now;

  /** Loads and validates; null when the id is invalid, missing or corrupt. */
  async function load(id: string): Promise<BankState | null> {
    if (!ID_PATTERN.test(id)) return null;
    const raw = await redis.get(key(id));
    if (raw === null || raw === undefined) return null;
    return toState(raw);
  }

  async function limited(rateKey: string, limit: number): Promise<RateResult> {
    try {
      return await hit(redis, rateKey, limit, 60);
    } catch {
      // Fail closed without exposing the error.
      return { allowed: false, retryAfter: 1 };
    }
  }

  return {
    async createSandbox() {
      const id = newId();
      await redis.set(key(id), JSON.stringify(seedState()), { ex: TTL_SECONDS });
      return {
        id,
        expiresAt: new Date(now() + TTL_SECONDS * 1000).toISOString(),
      };
    },

    loadState: load,

    async runOnSandbox<T>(
      id: string,
      fn: (s: BankState) => { state: BankState; response: T },
    ): Promise<RunResult<T>> {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const loaded = await load(id);
          if (!loaded) return { ok: false, reason: "not-found" };

          const result = fn(loaded);
          if (result.state === loaded) {
            return { ok: true, response: result.response };
          }

          const json = JSON.stringify(result.state);
          if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) {
            return { ok: false, reason: "too-large" };
          }

          const written = await redis.compareAndSet(
            key(id),
            loaded.version,
            json,
            TTL_SECONDS,
          );
          if (written) return { ok: true, response: result.response };
        }
        return { ok: false, reason: "conflict" };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async resetSandbox(id) {
      const loaded = await load(id);
      if (!loaded) return false;
      const fresh: BankState = { ...seedState(), version: loaded.version + 1 };
      await redis.set(key(id), JSON.stringify(fresh), { ex: TTL_SECONDS });
      return true;
    },

    allowCreate(ip) {
      return limited(`gw-create-rl:${cleanIp(ip)}`, 10);
    },

    async allowCall(id) {
      if (!ID_PATTERN.test(id)) return { allowed: false, retryAfter: 1 };
      return limited(`gw-rl:${id}`, 120);
    },
  };
}

let cached: GwStore | undefined;

/** Builds the default store on first use, never at import time. */
function defaultStore(): GwStore {
  if (!cached) {
    const env = getEnv();
    const client = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    cached = createStore({
      get: (k) => client.get(k),
      set: (k, value, o) => client.set(k, value, { ex: o.ex }),
      incr: (k) => client.incr(k),
      expire: (k, sec) => client.expire(k, sec),
      ttl: (k) => client.ttl(k),
      compareAndSet: async (k, expectedVersion, value, ttlSec) => {
        const res = await client.eval(
          COMPARE_AND_SET_SCRIPT,
          [k],
          [String(expectedVersion), value, String(ttlSec)],
        );
        return Number(res) === 1;
      },
    });
  }
  return cached;
}

/** Default store; resolves env and the Redis client lazily on each call. */
export const store: GwStore = {
  createSandbox: () => defaultStore().createSandbox(),
  loadState: (id) => defaultStore().loadState(id),
  runOnSandbox: (id, fn) => defaultStore().runOnSandbox(id, fn),
  resetSandbox: (id) => defaultStore().resetSandbox(id),
  allowCreate: (ip) => defaultStore().allowCreate(ip),
  allowCall: (id) => defaultStore().allowCall(id),
};

export default store;
