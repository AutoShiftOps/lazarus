// In-memory RedisLike for registry tests. Records the TTL given on every set.
// The FakeRedis class inside tests/registry/index.test.ts is private to that file, so this
// shared copy serves the rules/settings tests. Set failWith to make every command reject.

import type { RedisLike } from "../../lib/registry";

export interface FakeRegistryRedis extends RedisLike {
  readonly store: Map<string, string>;
  readonly ttls: Map<string, number>;
  failWith: Error | undefined;
}

export function createFakeRegistryRedis(): FakeRegistryRedis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const fake: FakeRegistryRedis = {
    store,
    ttls,
    failWith: undefined,
    async get(key) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      return store.get(key) ?? null;
    },
    async set(key, value, options) {
      await Promise.resolve();
      if (fake.failWith) throw fake.failWith;
      if (options.nx === true && store.has(key)) return null;
      store.set(key, value);
      ttls.set(key, options.ex);
      return "OK";
    },
  };
  return fake;
}
