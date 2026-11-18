// In-memory TranscriptRedis for tests, with real LPUSH / LTRIM / LRANGE / EXPIRE semantics:
// LPUSH prepends, LTRIM and LRANGE use inclusive indexes and accept negatives, EXPIRE records the TTL.
// TTLs are recorded but not enforced. Set failWith to make every command reject.

import type { TranscriptRedis } from "../../lib/safety/transcript";

export interface FakeTranscriptRedis extends TranscriptRedis {
  readonly lists: Map<string, string[]>;
  readonly ttls: Map<string, number>;
  failWith: Error | undefined;
}

/** Resolves Redis start/stop (inclusive, negatives from the end) to a slice range, or null if empty. */
function range(len: number, start: number, stop: number): [number, number] | null {
  let s = start < 0 ? len + start : start;
  let e = stop < 0 ? len + stop : stop;
  if (s < 0) s = 0;
  if (e >= len) e = len - 1;
  if (len === 0 || s > e) return null;
  return [s, e + 1];
}

export function createFakeTranscriptRedis(): FakeTranscriptRedis {
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  const fake: FakeTranscriptRedis = {
    lists,
    ttls,
    failWith: undefined,
    async lpush(key, ...elements) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      const l = lists.get(key) ?? [];
      for (const e of elements) l.unshift(e);
      lists.set(key, l);
      return l.length;
    },
    async ltrim(key, start, stop) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      const l = lists.get(key);
      if (!l) return "OK";
      const r = range(l.length, start, stop);
      if (r === null) lists.delete(key);
      else lists.set(key, l.slice(r[0], r[1]));
      return "OK";
    },
    async lrange(key, start, stop) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      const l = lists.get(key) ?? [];
      const r = range(l.length, start, stop);
      return r === null ? [] : l.slice(r[0], r[1]);
    },
    async expire(key, seconds) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      if (!lists.has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    },
  };
  return fake;
}
