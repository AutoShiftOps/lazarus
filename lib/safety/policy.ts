// lib/safety/policy.ts
// Pure policy engine: decides allow / hold / block / ghost for one call.
// Fails closed: an unevaluable condition makes block/hold rules match and allow rules not match.

import type { OperationSchema, Risk } from "../soap/types";
import type { Condition, Decision, Rule } from "./types";

export type PathResult =
  | { kind: "rejected" }
  | { kind: "notFound" }
  | { kind: "found"; value: unknown };

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Walks plain objects and arrays by own properties only. */
export function getPath(args: unknown, path: string): PathResult {
  if (typeof path !== "string") return { kind: "rejected" };
  const segments = path.split(".");
  for (const s of segments) {
    if (s === "" || FORBIDDEN_SEGMENTS.has(s)) return { kind: "rejected" };
  }
  let current: unknown = args;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(seg) || !Object.hasOwn(current, seg)) return { kind: "notFound" };
      current = (current as unknown[])[Number(seg)];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, seg)) return { kind: "notFound" };
      current = current[seg];
    } else {
      return { kind: "notFound" };
    }
  }
  return { kind: "found", value: current };
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!NUMERIC.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** true/false when comparable, null when types are unevaluable. */
function looseEquals(a: unknown, b: unknown): boolean | null {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return typeof a === "boolean" && typeof b === "boolean" ? a === b : null;
  }
  const okA = typeof a === "string" || (typeof a === "number" && Number.isFinite(a));
  const okB = typeof b === "string" || (typeof b === "number" && Number.isFinite(b));
  if (!okA || !okB) return null;
  return String(a) === String(b);
}

function evaluateRaw(cond: Condition, args: unknown): boolean | "unknown" {
  const res = getPath(args, cond.field);
  if (res.kind !== "found") return "unknown";
  const actual = res.value;
  const expected: unknown = cond.value;

  switch (cond.op) {
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null || b === null) return "unknown";
      if (cond.op === "gt") return a > b;
      if (cond.op === "gte") return a >= b;
      if (cond.op === "lt") return a < b;
      return a <= b;
    }
    case "eq":
    case "neq": {
      const eq = looseEquals(actual, expected);
      if (eq === null) return "unknown";
      return cond.op === "eq" ? eq : !eq;
    }
    case "contains": {
      if (typeof actual === "string") {
        if (typeof expected !== "string" && typeof expected !== "number") return "unknown";
        return actual.includes(String(expected));
      }
      if (Array.isArray(actual)) {
        const comparable =
          typeof expected === "string" ||
          typeof expected === "boolean" ||
          (typeof expected === "number" && Number.isFinite(expected));
        if (!comparable) return "unknown";
        return (actual as unknown[]).some((item) => looseEquals(item, expected) === true);
      }
      return "unknown";
    }
    default:
      return "unknown";
  }
}

/**
 * Evaluates a condition: true or false when evaluable, "unknown" when the field is
 * missing, the types do not fit, the operator is unknown, the path is rejected, or
 * evaluation throws.
 */
export function evaluate(cond: Condition, args: unknown): boolean | "unknown" {
  try {
    return evaluateRaw(cond, args);
  } catch {
    return "unknown";
  }
}

/**
 * Fail-closed-for-restrictive-effects helper: true for an absent condition and for any
 * unevaluable condition. Correct for block/hold rules only; `decide` treats an
 * unevaluable condition on an allow rule as not matching.
 */
export function holds(cond: Condition | undefined, args: unknown): boolean {
  if (cond === undefined) return true;
  return evaluate(cond, args) !== false;
}

/** Whether a rule's condition makes it match: unknown matches block/hold, never allow. */
function conditionMatches(r: Rule, args: unknown): boolean {
  if (r.when === undefined) return true;
  const v = evaluate(r.when, args);
  return v === true || (v === "unknown" && r.effect !== "allow");
}

export function decide(input: {
  op: OperationSchema;
  risk: Risk;
  args: unknown;
  rules: Rule[];
  ghost: boolean;
}): Decision {
  const { op, risk, args, rules, ghost } = input;

  // 1. Matching rules, in array order.
  const matching = rules.filter(
    (r) => (r.operation === op.name || r.operation === "*") && conditionMatches(r, args),
  );

  // 2. block wins.
  const block = matching.find((r) => r.effect === "block");
  if (block) return { action: "block", ruleId: block.id, reason: block.reason };

  // 3. ghost for non-read calls.
  if (ghost && risk !== "read") {
    return { action: "ghost", reason: "Ghost mode: nothing is sent to the real service" };
  }

  // 4. hold rules.
  const hold = matching.find((r) => r.effect === "hold");
  if (hold) return { action: "hold", ruleId: hold.id, reason: hold.reason };

  // 5. destructive default hold unless an allow rule names the operation explicitly.
  const allow = matching.find((r) => r.effect === "allow");
  if (risk === "destructive") {
    const explicit = matching.find((r) => r.effect === "allow" && r.operation === op.name);
    if (!explicit) return { action: "hold", reason: "Destructive operation" };
    return { action: "allow", ruleId: explicit.id, reason: explicit.reason };
  }

  // 6. allow.
  if (allow) return { action: "allow", ruleId: allow.id, reason: allow.reason };
  return { action: "allow", reason: `Default policy for ${risk} operation` };
}
