// lib/rate-limit.ts
// Fixed-window rate limiter over a minimal Redis surface. Shared across specs.

/** Minimal Redis surface needed for counting. */
export type RateRedis = {
  incr(key: string): Promise<number>;
  expire(key: string, sec: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
};

export type RateResult = { allowed: boolean; retryAfter: number };

/**
 * Counts one hit for `key` in a window of `windowSec` seconds.
 * The expiry is set on the first hit, and set again whenever the key has no
 * TTL, so a counter can never get stuck forever. Errors propagate to the caller.
 */
export async function hit(
  redis: RateRedis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }
  let ttl = await redis.ttl(key);
  if (ttl < 0) {
    await redis.expire(key, windowSec);
    ttl = windowSec;
  }
  return { allowed: count <= limit, retryAfter: Math.max(1, ttl) };
}
