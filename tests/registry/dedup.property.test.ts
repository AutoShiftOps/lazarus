// tests/registry/dedup.property.test.ts
// **Property 7: Registry deduplication (idempotence)**
// Validates: Requirements 6.3

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createRegistry, type RedisLike } from "../../lib/registry/index";
import type { ServiceDefinition } from "../../lib/soap/types";

/** In-memory RedisLike fake with ex/nx semantics; counts writes to `service:*` keys. */
function createFakeRedis(): RedisLike & { serviceWrites: number } {
  const store = new Map<string, string>();
  const fake = {
    serviceWrites: 0,
    async get(key: string): Promise<unknown> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(
      key: string,
      value: string,
      options: { ex: number; nx?: boolean },
    ): Promise<unknown> {
      if (options.nx && store.has(key)) return null;
      if (key.startsWith("service:")) fake.serviceWrites += 1;
      store.set(key, value);
      return "OK";
    },
  };
  return fake;
}

const wsdlUrlArb = fc
  .webUrl()
  .map((u) => u + "?WSDL");

describe("Property 7: Registry deduplication (idempotence)", () => {
  it("upserting the same WSDL URL twice yields one id and one service write", async () => {
    await fc.assert(
      fc.asyncProperty(wsdlUrlArb, fc.string(), async (wsdlUrl, name) => {
        const fake = createFakeRedis();
        const reg = createRegistry(fake);
        const def: ServiceDefinition = { name, wsdlUrl, ports: [], warnings: [] };

        const first = await reg.upsertService(def);
        const second = await reg.upsertService(def);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        expect(fake.serviceWrites).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
