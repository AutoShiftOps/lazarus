// In-memory RateRedis for tests. Expiry is lazy and driven by an injected clock (milliseconds),
// so tests move time forward without sleeping. Set failWith to make every command reject.

import type { RateRedis } from "../../lib/rate-limit";

export interface FakeRateRedis extends RateRedis {
  failWith: Error | undefined;
}

export function createFakeRateRedis(now: () => number): FakeRateRedis {
  const counts = new Map<string, number>();
  const expiresAt = new Map<string, number>();

  /** Drops the key when its expiry has passed. */
  function sweep(key: string): void {
    const exp = expiresAt.get(key);
    if (exp !== undefined && now() >= exp) {
      counts.delete(key);
      expiresAt.delete(key);
    }
  }

  const fake: FakeRateRedis = {
    failWith: undefined,
    async incr(key) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      sweep(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire(key, sec) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      sweep(key);
      if (!counts.has(key)) return 0;
      expiresAt.set(key, now() + sec * 1000);
      return 1;
    },
    async ttl(key) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      sweep(key);
      if (!counts.has(key)) return -2;
      const exp = expiresAt.get(key);
      if (exp === undefined) return -1;
      return Math.ceil((exp - now()) / 1000);
    },
  };
  return fake;
}
