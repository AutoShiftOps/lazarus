import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  generateOwnerToken,
  hashOwnerToken,
  publicDefinition,
  verifyOwnerToken,
} from "../lib/owner-token";
import type { ServiceDefinition } from "../lib/soap/types";

describe("owner-token", () => {
  it("generates distinct 43-char base64url tokens with a matching hash", async () => {
    const a = await generateOwnerToken();
    const b = await generateOwnerToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(await hashOwnerToken(a.token));
  });

  it("verifies the right token and rejects wrong, empty, short and non-string input", async () => {
    const { token, hash } = await generateOwnerToken();
    expect(await verifyOwnerToken(token, hash)).toBe(true);
    expect(await verifyOwnerToken("wrong", hash)).toBe(false);
    expect(await verifyOwnerToken("", hash)).toBe(false);
    expect(await verifyOwnerToken(token.slice(0, 10), hash)).toBe(false);
    expect(await verifyOwnerToken(token, "short")).toBe(false);
    expect(await verifyOwnerToken(undefined as unknown as string, hash)).toBe(false);
  });

  it("publicDefinition removes the hash and leaves the input untouched", () => {
    const def: ServiceDefinition = {
      name: "S",
      wsdlUrl: "http://x/",
      ports: [],
      warnings: [],
      ownerTokenHash: "abc",
    };
    const pub = publicDefinition(def);
    expect("ownerTokenHash" in pub).toBe(false);
    expect(pub.name).toBe("S");
    expect(def.ownerTokenHash).toBe("abc");
  });

  it("verify round-trips for any string and fails when the token is altered", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (t) => {
        const hash = await hashOwnerToken(t);
        expect(await verifyOwnerToken(t, hash)).toBe(true);
        expect(await verifyOwnerToken(t + "x", hash)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
