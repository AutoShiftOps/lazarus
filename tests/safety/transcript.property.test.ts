import fc from "fast-check";
import { describe, it } from "vitest";
import { createTranscripts } from "../../lib/safety/transcript";
import type { TranscriptEntry } from "../../lib/safety/types";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const SENSITIVE_KEYS = ["password", "Password", "token", "accessToken", "Authorization", "apiKey", "api_key", "clientSecret"];

/** Wraps `inner` in `path.length` levels of object/array nesting. */
function wrap(path: { key: string; array: boolean }[], inner: unknown): unknown {
  return path.reduceRight<unknown>(
    (acc, step) => (step.array ? [acc, 1] : { [step.key]: acc, keep: "visible" }),
    inner,
  );
}

describe("transcript redaction (property)", () => {
  // Feature: mcp-gateway, Property 19: stored transcripts never contain secret values
  /** **Validates: Requirements 8.3** */
  it("never stores secret values placed under sensitive keys at any depth", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ key: fc.constantFrom("a", "b", "data", "items"), array: fc.boolean() }), {
          maxLength: 6,
        }),
        fc.constantFrom(...SENSITIVE_KEYS),
        fc.stringMatching(/^[0-9a-f]{8,16}$/),
        fc.jsonValue(),
        async (path, sensitiveKey, hex, noise) => {
          const secret = `ZZsecret${hex}`;
          const args = wrap(path, { [sensitiveKey]: secret, noise });
          const redis = createFakeTranscriptRedis();
          const t = createTranscripts(redis);
          const e: TranscriptEntry = {
            id: "p",
            ts: "2026-01-01T00:00:00.000Z",
            tool: "T",
            args,
            risk: "read",
            decision: "allow",
            outcome: "ok",
            durationMs: 1,
            summary: "s",
          };
          await t.appendTranscript("svc12345", e);
          const stored = redis.lists.get("transcripts:svc12345") ?? [];
          return stored.length === 1 && !stored[0].includes(secret);
        },
      ),
      { numRuns: 200 },
    );
  });
});
