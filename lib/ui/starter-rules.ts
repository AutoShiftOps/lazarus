import type { Rule } from "../safety/types";
import type { Risk } from "../soap/types";

export type StarterOperation = { name: string; risk: Risk; inputFields: string[] };

export type StarterRule = {
  id: string;
  label: string;
  description: string;
  rules: Rule[];
};

/** The server accepts at most this many rules (RuleSetSchema). */
export const MAX_RULES = 25;

export const TRANSFER_THRESHOLD = 1000;

/** Rule ids must be 1-64 characters. */
export function defaultRuleId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `r_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Offers the starter rules that fit this service. The transfer rule uses the operation's own field
 * name (for example "Amount"), because conditions look fields up by exact name.
 */
export function starterRules(operations: StarterOperation[], newId: () => string = defaultRuleId): StarterRule[] {
  const starters: StarterRule[] = [];

  const holds: Rule[] = [];
  for (const op of operations) {
    if (!op.name.toLowerCase().includes("transfer")) continue;
    const field = op.inputFields.find((f) => f.toLowerCase() === "amount");
    if (field === undefined) continue;
    holds.push({
      id: newId(),
      operation: op.name,
      when: { field, op: "gt", value: TRANSFER_THRESHOLD },
      effect: "hold",
      reason: "Large transfer",
    });
  }
  if (holds.length > 0) {
    starters.push({
      id: "hold-large-transfers",
      label: "Hold transfers over 1000",
      description: "A human must approve any transfer above 1000.",
      rules: holds,
    });
  }

  const blocks: Rule[] = operations
    .filter((op) => op.risk === "destructive")
    .map((op) => ({
      id: newId(),
      operation: op.name,
      effect: "block" as const,
      reason: "Destructive calls are blocked",
    }));
  if (blocks.length > 0) {
    starters.push({
      id: "block-destructive",
      label: "Block all destructive calls",
      description: "Destructive operations are refused outright, with no approval step.",
      rules: blocks,
    });
  }

  return starters;
}

/** Same operation, condition and effect. Ids and reasons are ignored. */
export function sameRule(a: Rule, b: Rule): boolean {
  if (a.operation !== b.operation || a.effect !== b.effect) return false;
  if (a.when === undefined || b.when === undefined) return a.when === b.when;
  return a.when.field === b.when.field && a.when.op === b.when.op && a.when.value === b.when.value;
}

/** True when every rule of the starter is already present. */
export function isStarterActive(starter: StarterRule, existing: Rule[]): boolean {
  return starter.rules.length > 0 && starter.rules.every((r) => existing.some((e) => sameRule(e, r)));
}

/** Adds the starter's rules that are missing. Existing rules are never dropped or reordered. */
export function mergeStarter(existing: Rule[], starter: StarterRule): Rule[] {
  const result = [...existing];
  for (const rule of starter.rules) {
    if (!result.some((e) => sameRule(e, rule))) result.push(rule);
  }
  return result;
}

/** Removes every existing rule that matches one of the starter's rules. */
export function removeStarter(existing: Rule[], starter: StarterRule): Rule[] {
  return existing.filter((e) => !starter.rules.some((r) => sameRule(e, r)));
}
