// tests/registry/id.property.test.ts
// **Property 6: Registry ID uniqueness and format**
// Validates: Requirements 6.1

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createRegistry, type RedisLike } from "../../lib/registry/index";
import type { ServiceDefinition } from "../../lib/soap/types";

/** In-memory RedisLike with `nx` semantics. Never touches real Redis. */
function createFakeRedis(): RedisLike {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, options) {
      if (options.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  };
}

function makeDef(wsdlUrl: string): ServiceDefinition {
  return { name: "Svc", wsdlUrl, ports: [], warnings: [] };
}

describe("Property 6: Registry ID uniqueness and format", () => {
  it("assigns distinct, 8-12 char alphanumeric ids to distinct WSDL URLs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.webUrl(), { minLength: 1, maxLength: 30 }),
        async (urls) => {
          const registry = createRegistry(createFakeRedis());
          const ids: string[] = [];
          for (const url of urls) {
            const result = await registry.upsertService(makeDef(url));
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.created).toBe(true);
            expect(result.id.length).toBeGreaterThanOrEqual(8);
            expect(result.id.length).toBeLessThanOrEqual(12);
            expect(result.id).toMatch(/^[A-Za-z0-9]+$/);
            ids.push(result.id);
          }
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});
