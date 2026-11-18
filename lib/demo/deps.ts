// lib/demo/deps.ts
// Composition root for the demo route. Nothing here touches env or Redis at import time.

import { Redis } from "@upstash/redis";
import { getEnv } from "../env";
import { store } from "../gravewood/store";
import { summonFromBody } from "../summon";
import type { DemoDeps } from "./index";

/** Builds the real dependencies; throws if the environment is not configured. */
export function defaultDemoDeps(origin: string): DemoDeps {
  const env = getEnv();
  const client = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  return {
    createSandbox: () => store.createSandbox(),
    summon: (rawBody, o) => summonFromBody(rawBody, o),
    rateRedis: {
      incr: (k) => client.incr(k),
      expire: (k, sec) => client.expire(k, sec),
      ttl: (k) => client.ttl(k),
    },
    origin,
  };
}
