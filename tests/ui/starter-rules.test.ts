import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RuleSchema, RuleSetSchema } from "../../lib/safety/schemas";
import type { Rule } from "../../lib/safety/types";
import {
  isStarterActive,
  mergeStarter,
  removeStarter,
  starterRules,
  type StarterOperation,
} from "../../lib/ui/starter-rules";

function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

const ops: StarterOperation[] = [
  { name: "GetBalance", risk: "read", inputFields: ["accountId"] },
  { name: "TransferFunds", risk: "write", inputFields: ["from", "to", "Amount"] },
  { name: "CloseAccount", risk: "destructive", inputFields: ["accountId"] },
  { name: "PurgeAll", risk: "destructive", inputFields: [] },
];

describe("starterRules", () => {
  it("offers both starters with valid rules", () => {
    const starters = starterRules(ops, counter());
    expect(starters.map((s) => s.label)).toEqual(["Hold transfers over 1000", "Block all destructive calls"]);
    expect(starters[0].rules).toEqual([
      {
        id: "id1",
        operation: "TransferFunds",
        when: { field: "Amount", op: "gt", value: 1000 },
        effect: "hold",
        reason: "Large transfer",
      },
    ]);
    expect(starters[1].rules.map((r) => [r.operation, r.effect, r.reason])).toEqual([
      ["CloseAccount", "block", "Destructive calls are blocked"],
      ["PurgeAll", "block", "Destructive calls are blocked"],
    ]);
    for (const s of starters) for (const r of s.rules) expect(RuleSchema.safeParse(r).success).toBe(true);
    expect(RuleSetSchema.safeParse(starters.flatMap((s) => s.rules)).success).toBe(true);
  });

  it("omits starters that do not apply", () => {
    expect(starterRules([{ name: "GetBalance", risk: "read", inputFields: ["amount"] }])).toEqual([]);
    expect(starterRules([{ name: "transferX", risk: "write", inputFields: ["total"] }])).toEqual([]);
    const lower = starterRules([{ name: "bank_transfer", risk: "write", inputFields: ["AMOUNT"] }]);
    expect(lower).toHaveLength(1);
  });

  it("merges without duplicates and removes only matching rules", () => {
    const [hold, block] = starterRules(ops, counter());
    const mine: Rule = { id: "mine", operation: "GetBalance", effect: "allow", reason: "ok" };
    const merged = mergeStarter([mine], hold);
    expect(merged).toEqual([mine, ...hold.rules]);
    expect(isStarterActive(hold, merged)).toBe(true);
    expect(isStarterActive(block, merged)).toBe(false);
    // A rule with another id and reason but the same operation, condition and effect counts as present.
    const [again] = starterRules(ops, counter());
    expect(mergeStarter(merged, { ...again, rules: again.rules.map((r) => ({ ...r, reason: "other" })) })).toEqual(merged);
    expect(removeStarter(merged, hold)).toEqual([mine]);
  });
});

describe("starter rule merge (property)", () => {
  const opArb = fc.record({
    name: fc.constantFrom("TransferFunds", "BankTransfer", "Close", "Get", "Wipe"),
    risk: fc.constantFrom("read" as const, "write" as const, "destructive" as const),
    inputFields: fc.subarray(["amount", "Amount", "id", "to"]),
  });
  const ruleArb: fc.Arbitrary<Rule> = fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    operation: fc.constantFrom("TransferFunds", "Close", "Wipe", "*"),
    effect: fc.constantFrom("allow" as const, "hold" as const, "block" as const),
    reason: fc.string({ maxLength: 20 }),
  });

  it("is idempotent and never drops existing rules", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 6 }), fc.array(ruleArb, { maxLength: 8 }), (operations, existing) => {
        for (const starter of starterRules(operations, counter())) {
          const once = mergeStarter(existing, starter);
          const twice = mergeStarter(once, starter);
          expect(twice).toEqual(once);
          expect(once.slice(0, existing.length)).toEqual(existing);
          expect(isStarterActive(starter, once)).toBe(true);
        }
      }),
    );
  });
});
