// lib/mcp/deps.ts
// Composition root for the pipeline. Nothing here touches env or Redis at import time:
// defaultDeps() builds everything when it is called, once per request.

import { Redis } from "@upstash/redis";
import { nanoid } from "nanoid";
import { getEnv } from "../env";
import type { RateRedis } from "../rate-limit";
import { registry } from "../registry";
import { createApprovals, type ApprovalsRedis } from "../safety/approvals";
import { createTranscripts, type TranscriptRedis, type Transcripts } from "../safety/transcript";
import { safePost } from "../soap/fetcher";
import type { Deps } from "./pipeline";

/** The Redis methods the gateway needs, as the three injected interfaces combined. */
export type GatewayRedis = ApprovalsRedis & TranscriptRedis & RateRedis;

/**
 * Thin typed adapter over the Upstash client. The client methods are generic and variadic, so each
 * one is pinned to the exact shape the injected interfaces declare.
 * Note: the Upstash client JSON-deserialises string values on reads; the approvals and transcript
 * modules accept both strings and already-parsed values.
 */
export function adaptRedis(client: Redis): GatewayRedis {
  return {
    hset: (key, fields) => client.hset(key, fields),
    hgetall: (key) => client.hgetall<Record<string, unknown>>(key),
    expire: (key, seconds) => client.expire(key, seconds),
    eval: (script, keys, args) => client.eval(script, keys, args),
    lpush: (key, ...elements) => client.lpush(key, ...elements),
    ltrim: (key, start, stop) => client.ltrim(key, start, stop),
    lrange: (key, start, stop) => client.lrange<unknown>(key, start, stop),
    incr: (key) => client.incr(key),
    ttl: (key) => client.ttl(key),
  };
}

/** The pipeline deps, with the full transcript store (the pipeline only needs append; the API also lists). */
export type DefaultDeps = Deps & { transcripts: Transcripts };

export function defaultDeps(): DefaultDeps {
  const env = getEnv();
  const redis = adaptRedis(new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }));
  return {
    registry,
    transcripts: createTranscripts(redis),
    approvals: createApprovals(redis),
    post: safePost,
    rateRedis: redis,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    newId: () => nanoid(),
  };
}
