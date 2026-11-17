// Feature: gravewood-bank, Property 13: amount parsing round-trip
// **Validates: Requirements 4.1, 4.2**
import { describe, it } from "vitest";
import fc from "fast-check";
import { formatCents, parseAmountToCents } from "../../lib/gravewood/money";

const ASCII_AMOUNT = /^[0-9]{1,12}(\.[0-9]{1,2})?$/;

describe("Property 13: amount parsing round-trip", () => {
  it("parse(format(c)) === c when <= 12 integer digits, else null", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 ** 14 - 1 }), (c) => {
        const s = formatCents(c);
        const intDigits = s.split(".")[0].length;
        const parsed = parseAmountToCents(s);
        if (intDigits <= 12) return parsed === c;
        return parsed === null;
      }),
      { numRuns: 200 },
    );
  });

  it("returns null for strings not matching the amount grammar", () => {
    const arb = fc
      .oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" }))
      .filter((s) => !ASCII_AMOUNT.test(s));
    fc.assert(fc.property(arb, (s) => parseAmountToCents(s) === null), { numRuns: 200 });
  });
});
