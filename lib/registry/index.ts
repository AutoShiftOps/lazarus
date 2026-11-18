// lib/registry/index.ts
// Redis-backed registry of ServiceDefinition records. No Redis or env access at import time.

import { Redis } from "@upstash/redis";
import { customAlphabet } from "nanoid";
import { getEnv } from "../env";
import { RuleSetSchema, SettingsSchema, type RuleSetInput, type Settings } from "../safety/schemas";
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

export type PutResult = { ok: true } | { ok: false; error: LazarusError };

export interface Registry {
  upsertService(def: ServiceDefinition): Promise<UpsertResult>;
  getService(id: string): Promise<RegistryResult<ServiceDefinition | null>>;
  /** No stored rules reads as []. Corrupt stored data fails closed with REGISTRY_UNAVAILABLE. */
  getRules(id: string): Promise<RegistryResult<RuleSetInput>>;
  putRules(id: string, rules: unknown): Promise<PutResult>;
  /** No stored settings reads as { ghost: false }. Corrupt stored data fails closed. */
  getSettings(id: string): Promise<RegistryResult<Settings>>;
  putSettings(id: string, settings: unknown): Promise<PutResult>;
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

const MAX_ERROR_MESSAGE = 500;

function invalidRequest(message: string): { ok: false; error: LazarusError } {
  return {
    ok: false,
    error: { code: "INVALID_REQUEST", message: message.slice(0, MAX_ERROR_MESSAGE) },
  };
}

function parseStored(raw: unknown): unknown {
  if (typeof raw !== "string") return raw; // the Upstash client may already have parsed it
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function firstDuplicateId(rules: RuleSetInput): string | undefined {
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) return r.id;
    seen.add(r.id);
  }
  return undefined;
}

function validateRules(
  input: unknown,
): { ok: true; value: RuleSetInput } | { ok: false; message: string } {
  const parsed = RuleSetSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "rules"}: ${i.message}`)
      .join("; ");
    return { ok: false, message: `Invalid rules. ${message}` };
  }
  const dup = firstDuplicateId(parsed.data);
  if (dup !== undefined) return { ok: false, message: `Invalid rules. Duplicate rule id: ${dup}` };
  return { ok: true, value: parsed.data };
}

export function createRegistry(redis: RedisLike): Registry {
  async function readStored(key: string): Promise<unknown> {
    return redis.get(key);
  }

  return {
    async getRules(id) {
      if (!ID_PATTERN.test(id)) return { ok: true, value: [] };
      try {
        const raw = await readStored(`rules:${id}`);
        if (raw === null || raw === undefined) return { ok: true, value: [] };
        const parsed = validateRules(parseStored(raw));
        if (!parsed.ok) return { ok: false, error: { ...UNAVAILABLE } };
        return { ok: true, value: parsed.value };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },

    async putRules(id, rules) {
      const v = validateRules(rules);
      if (!v.ok) return invalidRequest(v.message);
      if (!ID_PATTERN.test(id)) return invalidRequest("Invalid service id.");
      try {
        await redis.set(`rules:${id}`, JSON.stringify(v.value), { ex: TTL_SECONDS });
        return { ok: true };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },

    async getSettings(id) {
      if (!ID_PATTERN.test(id)) return { ok: true, value: { ghost: false } };
      try {
        const raw = await readStored(`settings:${id}`);
        if (raw === null || raw === undefined) return { ok: true, value: { ghost: false } };
        const parsed = SettingsSchema.safeParse(parseStored(raw));
        if (!parsed.success) return { ok: false, error: { ...UNAVAILABLE } };
        return { ok: true, value: parsed.data };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },

    async putSettings(id, settings) {
      const parsed = SettingsSchema.safeParse(settings);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "settings"}: ${i.message}`)
          .join("; ");
        return invalidRequest(`Invalid settings. ${message}`);
      }
      if (!ID_PATTERN.test(id)) return invalidRequest("Invalid service id.");
      try {
        await redis.set(`settings:${id}`, JSON.stringify(parsed.data), { ex: TTL_SECONDS });
        return { ok: true };
      } catch {
        return { ok: false, error: { ...UNAVAILABLE } };
      }
    },

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
  async getRules(id) {
    try {
      return await defaultRegistry().getRules(id);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
  async putRules(id, rules) {
    try {
      return await defaultRegistry().putRules(id, rules);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
  async getSettings(id) {
    try {
      return await defaultRegistry().getSettings(id);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
  async putSettings(id, settings) {
    try {
      return await defaultRegistry().putSettings(id, settings);
    } catch {
      return { ok: false, error: { ...UNAVAILABLE } };
    }
  },
};

export const upsertService = registry.upsertService;
export const getRules = registry.getRules;
export const putRules = registry.putRules;
export const getSettings = registry.getSettings;
export const putSettings = registry.putSettings;
export const getService = registry.getService;
export default registry;
