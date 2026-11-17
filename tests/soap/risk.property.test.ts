import fc from "fast-check";
import { describe, it } from "vitest";
import { heuristicRisk, mergeRisk } from "../../lib/soap/risk";
import type { Risk } from "../../lib/soap/types";

const RANK: Record<Risk, number> = { read: 0, write: 1, destructive: 2 };
const riskArb = fc.constantFrom<Risk>("read", "write", "destructive");
const DESTRUCTIVE = [
  "delete", "remove", "close", "cancel", "terminate", "revoke", "purge", "drop", "destroy", "void", "deactivate", "disable",
];

describe("risk properties", () => {
  // Feature: summon, Property 25: Model can never lower a class
  it("Property 25: mergeRisk is never less restrictive than either input", () => {
    // **Validates: Requirements 11.5**
    fc.assert(
      fc.property(riskArb, riskArb, (h, m) => {
        const r = mergeRisk(h, m);
        return RANK[r] >= RANK[h] && RANK[r] >= RANK[m];
      }),
      { numRuns: 200 },
    );
  });

  // Feature: summon, Property 26: Heuristic is total and deterministic
  it("Property 26: heuristicRisk is total and deterministic", () => {
    // **Validates: Requirements 11.1, 11.2**
    const nameArb = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" }));
    fc.assert(
      fc.property(nameArb, fc.option(fc.string(), { nil: undefined }), (name, doc) => {
        const a = heuristicRisk(name, doc);
        const b = heuristicRisk(name, doc);
        return (
          a.risk in RANK && a.reason.length <= 120 && a.risk === b.risk && a.reason === b.reason
        );
      }),
      { numRuns: 200 },
    );
  });

  // Feature: summon, Property 27: Destructive words win
  it("Property 27: any name containing a destructive word is destructive", () => {
    // **Validates: Requirements 11.2**
    const caseArb = (w: string) =>
      fc
        .array(fc.boolean(), { minLength: w.length, maxLength: w.length })
        .map((flags) => [...w].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(""));
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE).chain(caseArb),
        fc.string(),
        fc.string(),
        (word, prefix, suffix) => heuristicRisk(`${prefix}${word}${suffix}`).risk === "destructive",
      ),
      { numRuns: 200 },
    );
  });
});
