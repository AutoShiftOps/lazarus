import type { CondOp, Condition, Effect, Rule } from "../safety/types";

const MAX_LENGTH = 299;

const OPERATORS: Record<CondOp, string> = {
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
};

const VERBS: Record<Effect, string> = {
  allow: "Allow",
  hold: "Hold",
  block: "Block",
};

function formatValue(value: Condition["value"]): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function formatCondition(when: Condition | undefined): string {
  if (!when) return "always";
  return `when ${when.field} ${OPERATORS[when.op]} ${formatValue(when.value)}`;
}

/** Describes a rule as one English sentence. Pure; output is non-empty and under 300 characters. */
export function ruleToEnglish(rule: Rule): string {
  const target = rule.operation === "*" ? "any operation" : rule.operation;
  const head = `${VERBS[rule.effect]} ${target} ${formatCondition(rule.when)}`;
  const reason = rule.reason.trim();
  if (reason.length === 0) return head.slice(0, MAX_LENGTH);

  const prefix = `${head} — "`;
  const suffix = `"`;
  const room = MAX_LENGTH - prefix.length - suffix.length;
  if (room < 2) return head.slice(0, MAX_LENGTH);
  const shown = reason.length <= room ? reason : `${reason.slice(0, room - 1)}…`;
  return `${prefix}${shown}${suffix}`;
}
