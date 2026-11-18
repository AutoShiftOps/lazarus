import { describe, it, expect } from "vitest";
import {
  ConditionSchema,
  RuleSchema,
  RuleSetSchema,
  SettingsSchema,
  ApprovalDecisionSchema,
} from "../../lib/safety/schemas";

const rule = (i = 1) => ({ id: `r${i}`, operation: "*", effect: "hold" as const, reason: "x" });

describe("ConditionSchema", () => {
  it("accepts string, number and boolean values", () => {
    for (const value of ["a", 1, true]) {
      expect(ConditionSchema.safeParse({ field: "amount", op: "gt", value }).success).toBe(true);
    }
  });
  it("rejects bad op, empty field, 101-char field, object value", () => {
    expect(ConditionSchema.safeParse({ field: "a", op: "like", value: 1 }).success).toBe(false);
    expect(ConditionSchema.safeParse({ field: "", op: "eq", value: 1 }).success).toBe(false);
    expect(ConditionSchema.safeParse({ field: "a".repeat(101), op: "eq", value: 1 }).success).toBe(false);
    expect(ConditionSchema.safeParse({ field: "a".repeat(100), op: "eq", value: 1 }).success).toBe(true);
    expect(ConditionSchema.safeParse({ field: "a", op: "eq", value: {} }).success).toBe(false);
  });
});

describe("RuleSchema", () => {
  it("accepts a rule with and without `when`", () => {
    expect(RuleSchema.safeParse(rule()).success).toBe(true);
    const when = { field: "n", op: "lt", value: 3 };
    expect(RuleSchema.safeParse({ ...rule(), when }).success).toBe(true);
  });
  it("rejects bad effect, empty/long id, empty operation, invalid when", () => {
    expect(RuleSchema.safeParse({ ...rule(), effect: "deny" }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule(), id: "" }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule(), id: "a".repeat(65) }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule(), id: "a".repeat(64) }).success).toBe(true);
    expect(RuleSchema.safeParse({ ...rule(), operation: "" }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule(), when: { field: "", op: "eq", value: 1 } }).success).toBe(false);
  });
  it("accepts a 200-char reason and rejects 201", () => {
    expect(RuleSchema.safeParse({ ...rule(), reason: "r".repeat(200) }).success).toBe(true);
    expect(RuleSchema.safeParse({ ...rule(), reason: "r".repeat(201) }).success).toBe(false);
  });
});

describe("RuleSetSchema", () => {
  it("accepts 25 rules and rejects 26", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => rule(i));
    expect(RuleSetSchema.safeParse(mk(25)).success).toBe(true);
    expect(RuleSetSchema.safeParse(mk(26)).success).toBe(false);
  });
  it("accepts an empty list and rejects non-arrays", () => {
    expect(RuleSetSchema.safeParse([]).success).toBe(true);
    expect(RuleSetSchema.safeParse({}).success).toBe(false);
  });
});

describe("SettingsSchema", () => {
  it("accepts { ghost } booleans", () => {
    expect(SettingsSchema.safeParse({ ghost: true }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ghost: false }).success).toBe(true);
  });
  it("rejects non-boolean, missing and unknown keys", () => {
    expect(SettingsSchema.safeParse({ ghost: "yes" }).success).toBe(false);
    expect(SettingsSchema.safeParse({}).success).toBe(false);
    expect(SettingsSchema.safeParse({ ghost: true, extra: 1 }).success).toBe(false);
  });
});

describe("ApprovalDecisionSchema", () => {
  it("accepts approve/deny with optional note up to 300 chars", () => {
    expect(ApprovalDecisionSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(ApprovalDecisionSchema.safeParse({ decision: "deny", note: "n".repeat(300) }).success).toBe(true);
  });
  it("rejects bad decision, 301-char note and unknown keys", () => {
    expect(ApprovalDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse({ decision: "deny", note: "n".repeat(301) }).success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse({ decision: "approve", extra: 1 }).success).toBe(false);
  });
});
