// lib/registry/index.ts
// Redis-backed registry of ServiceDefinition records. No Redis or env access at import time.

import { Redis } from "@upstash/redis";
import { customAlphabet } from "nanoid";
import { getEnv } from "../env";
import type { LazarusError, ServiceDefinition } from "../soap/types";

const TTL_SECONDS = 2_592_000; // 30 days
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;
const ID_PATTERN = /^[A-Za-z0-9]{8,12}$/;

const newId = customAlphabet(ID_ALPHABET, ID_LENGTH);

/** Minimal Redis surface used by the registry. */
export interface RedisLike {
  get(key: string): Promise<unknown>;
  /** Resolves to null when `nx` is set and the key already exists. */
  set(
    key: string,
    value: string,
    options: { ex: number; nx?: boolean },
  ): Promise<unknown>;
}

export type UpsertResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; error: LazarusError };

export type RegistryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LazarusError };

export interface Registry {
  upsertService(def: ServiceDefinition): Promise<UpsertResult>;
  getService(id: string): Promise<RegistryResult<ServiceDefinition | null>>;
}

const UNAVAILABLE: LazarusError = {
  code: "REGISTRY_UNAVAILABLE",
  message: "The registry is temporarily unavailable.",
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural check only; the stored value was produced by this module. */
function toServiceDefinition(raw: unknown): ServiceDefinition | null {
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
    typeof value.name !== "string" ||
    typeof value.wsdlUrl !== "string" ||
    !Array.isArray(value.ports) ||
    !Array.isArray(value.warnings)
  ) {
    return null;
  }
  return value as unknown as ServiceDefinition;
}

export function createRegistry(redis: RedisLike): Registry {
  return {
    async upsertService(def) {
      try {
        const urlKey = `wsdl-url:${await sha256Hex(def.wsdlUrl)}`;

        const existing = await redis.get(urlKey);
        if (existing !== null && existing !== undefined) {
          return { ok: true, id: String(existing), created: false };
        }

        const id = newId();
        // Write the service first so a wsdl-url pointer never references a missing
        // service. If we lose the race, the orphan service expires via its TTL.
        await redis.set(`service:${id}`, JSON.stringify({ ...def, id }), {
          ex: TTL_SECONDS,
        });
        const claimed = await redis.set(urlKey, id, {
          ex: TTL_SECONDS,
          nx: true,
        });
        if (claimed === null) {
          const winner = await redis.get(urlKey);
          if (winner === null || winner === undefined) {
            return { ok: false, error: { ...UNAVAILABLE } };
          }
          return { ok: true, id: String(winner), created: false };
        }
        return { ok: true, id, created: true };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },

    async getService(id) {
      if (!ID_PATTERN.test(id)) return { ok: true, value: null };
      try {
        const raw = await redis.get(`service:${id}`);
        if (raw === null || raw === undefined) return { ok: true, value: null };
        return { ok: true, value: toServiceDefinition(raw) };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },
  };
}

let cached: Registry | undefined;

/** Builds the default registry on first use, never at import time. */
function defaultRegistry(): Registry {
  if (!cached) {
    const env = getEnv();
    const client = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    cached = createRegistry({
      get: (key) => client.get(key),
      set: (key, value, options) =>
        options.nx === true
          ? client.set(key, value, { ex: options.ex, nx: true })
          : client.set(key, value, { ex: options.ex }),
    });
  }
  return cached;
}

/** Default registry; resolves env and the Redis client lazily on each call. */
export const registry: Registry = {
  async upsertService(def) {
    try {
      return await defaultRegistry().upsertService(def);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
  async getService(id) {
    try {
      return await defaultRegistry().getService(id);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
};

export const upsertService = registry.upsertService;
export const getService = registry.getService;
export default registry;
