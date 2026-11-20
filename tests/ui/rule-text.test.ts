import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CondOp, Condition, Effect, Rule } from "../../lib/safety/types";
import { ruleToEnglish } from "../../lib/ui/rule-text";

const ops: CondOp[] = ["gt", "gte", "lt", "lte", "eq", "neq", "contains"];
const effects: Effect[] = ["allow", "hold", "block"];

const identifier = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

const conditionArb: fc.Arbitrary<Condition> = fc.record({
  field: identifier,
  op: fc.constantFrom(...ops),
  value: fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    fc.boolean(),
  ),
});

const ruleArb: fc.Arbitrary<Rule> = fc.record({
  id: fc.uuid(),
  operation: fc.oneof(identifier, fc.constant("*")),
  when: fc.option(conditionArb, { nil: undefined }),
  effect: fc.constantFrom(...effects),
  reason: fc.string({ maxLength: 200 }),
});

function rule(partial: Partial<Rule> = {}): Rule {
  return { id: "r1", operation: "TransferFunds", effect: "hold", reason: "Large transfer", ...partial };
}

describe("ruleToEnglish", () => {
  // Feature: seance-ui, Property 32: Rule text is total
  // **Validates: Requirements 7.3**
  it("Property 32: is total, non-empty, under 300 chars, and names the operation", () => {
    fc.assert(
      fc.property(ruleArb, (r) => {
        const text = ruleToEnglish(r);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThan(300);
        expect(text).toContain(r.operation === "*" ? "any operation" : r.operation);
      }),
      { numRuns: 200 },
    );
  });

  it("describes the example rule from the design", () => {
    const text = ruleToEnglish(
      rule({ when: { field: "amount", op: "gt", value: 1000 } }),
    );
    expect(text).toBe('Hold TransferFunds when amount is greater than 1000 — "Large transfer"');
  });

  it.each<[CondOp, string]>([
    ["gt", "is greater than"],
    ["gte", "is at least"],
    ["lt", "is less than"],
    ["lte", "is at most"],
    ["eq", "equals"],
    ["neq", "does not equal"],
    ["contains", "contains"],
  ])("renders operator %s as '%s'", (op, phrase) => {
    expect(ruleToEnglish(rule({ when: { field: "f", op, value: 1 } }))).toContain(`when f ${phrase} 1`);
  });

  it("renders a rule with no condition as always", () => {
    expect(ruleToEnglish(rule({ reason: "" }))).toBe("Hold TransferFunds always");
    expect(ruleToEnglish(rule())).toContain("Hold TransferFunds always");
  });

  it("renders * as any operation", () => {
    expect(ruleToEnglish(rule({ operation: "*", effect: "block" }))).toContain("Block any operation always");
  });

  it("quotes string values but not numbers or booleans", () => {
    const str = ruleToEnglish(rule({ when: { field: "to", op: "eq", value: "42" } }));
    const num = ruleToEnglish(rule({ when: { field: "to", op: "eq", value: 42 } }));
    const bool = ruleToEnglish(rule({ when: { field: "to", op: "eq", value: true } }));
    expect(str).toContain('to equals "42"');
    expect(num).toContain("to equals 42 ");
    expect(bool).toContain("to equals true ");
  });
});
