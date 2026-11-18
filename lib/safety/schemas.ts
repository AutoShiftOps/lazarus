import { z } from "zod";
import type { Condition, Rule } from "./types";

export const ConditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "contains"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const RuleSchema = z.object({
  id: z.string().min(1).max(64),
  operation: z.string().min(1).max(100),
  when: ConditionSchema.optional(),
  effect: z.enum(["allow", "hold", "block"]),
  reason: z.string().max(200),
});

export const RuleSetSchema = z.array(RuleSchema).max(25);

export const SettingsSchema = z.object({ ghost: z.boolean() }).strict();

export const ApprovalDecisionSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    note: z.string().max(300).optional(),
  })
  .strict();

export type ConditionInput = z.infer<typeof ConditionSchema>;
export type RuleInput = z.infer<typeof RuleSchema>;
export type RuleSetInput = z.infer<typeof RuleSetSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// Compile-time checks: schema-inferred types must be assignable to types.ts.
type AssertAssignable<_T extends U, U> = true;
export type _ConditionOk = AssertAssignable<ConditionInput, Condition>;
export type _RuleOk = AssertAssignable<RuleInput, Rule>;
