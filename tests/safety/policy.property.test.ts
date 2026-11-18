import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, evaluate, holds } from "../../lib/safety/policy";
import type { CondOp, Condition, Effect, Rule } from "../../lib/safety/types";
import type { OperationSchema, Risk } from "../../lib/soap/types";

// ---------------------------------------------------------------------------
// Shared arbitraries (reused by Properties 16, 17 and 18)
// ---------------------------------------------------------------------------

const opSchema = (name: string): OperationSchema => ({ name }) as unknown as OperationSchema;

const opName = fc.constantFrom("Transfer", "DeleteAccount", "CloseAccount", "Op");

const effectArb: fc.Arbitrary<Effect> = fc.constantFrom("allow", "hold", "block");

const condOpArb: fc.Arbitrary<CondOp> = fc.constantFrom("gt", "gte", "lt", "lte", "eq", "neq", "contains");

/** Present, absent, nested, array-index, forbidden and malformed paths. */
const fieldArb = fc.constantFrom(
  "amount",
  "transfer.amount",
  "a.b.c",
  "items.0",
  "note",
  "missing",
  "__proto__",
  "a.__proto__",
  "constructor",
  "constructor.name",
  "prototype",
  "",
  "a..b",
);

const condValueArb: fc.Arbitrary<string | number | boolean> = fc.oneof(
  fc.integer({ min: -1000, max: 100000 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(0, -0, Infinity, -Infinity, NaN),
  fc.string(),
  fc.constantFrom("", " ", "abc", "1e3", "0x10", "1000", "-5"),
  fc.boolean(),
);

const conditionArb: fc.Arbitrary<Condition> = fc.record({
  field: fieldArb,
  op: condOpArb,
  value: condValueArb,
});

/** Rule for a given op name: operation is the op name, "*", or something else. */
const ruleArb = (name: string): fc.Arbitrary<Rule> =>
  fc.record(
    {
      id: fc.string({ minLength: 1, maxLength: 8 }),
      operation: fc.oneof(
        fc.constant(name),
        fc.constant("*"),
        fc.constantFrom("Other", "Unrelated", "transfer", ""),
      ),
      when: conditionArb,
      effect: effectArb,
      reason: fc.string({ maxLength: 40 }),
    },
    { requiredKeys: ["id", "operation", "effect", "reason"] },
  );

const nestedAmountArb = fc.oneof(
  fc.integer({ min: -10, max: 1_000_000 }),
  fc.double({ noNaN: true }),
  fc.string(),
  fc.constantFrom("1000", "1e9", "abc", "", null),
);

const argsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.record(
    { amount: nestedAmountArb, note: fc.string() },
    { requiredKeys: [] },
  ),
  fc.record({
    transfer: fc.record({ amount: nestedAmountArb }),
    a: fc.record({ b: fc.record({ c: nestedAmountArb }) }),
    items: fc.array(nestedAmountArb, { maxLength: 3 }),
  }),
);

// ---------------------------------------------------------------------------
// Property 16: Destructive never runs unattended by default
// ---------------------------------------------------------------------------

describe("Property 16: Destructive never runs unattended by default", () => {
  /** Rule sets that contain no `allow` whose operation equals the op name (the precondition). */
  const noExplicitAllow = (name: string) =>
    fc.array(
      ruleArb(name).filter((r) => !(r.effect === "allow" && r.operation === name)),
      { maxLength: 8 },
    );

  /**
   * **Validates: Requirements 4.1, 4.7**
   */
  it("decide never returns allow for a destructive op without an explicit allow naming it", () => {
    const stats = { wildcardAllow: 0, otherAllow: 0, hold: 0, block: 0, ghost: 0, runs: 0 };

    fc.assert(
      fc.property(
        opName.chain((name) =>
          fc.tuple(fc.constant(name), noExplicitAllow(name), argsArb, fc.boolean()),
        ),
        ([name, rules, args, ghost]) => {
          // Precondition holds by construction; verify rather than assume.
          expect(rules.some((r) => r.effect === "allow" && r.operation === name)).toBe(false);

          const d = decide({ op: opSchema(name), risk: "destructive", args, rules, ghost });

          stats.runs++;
          if (rules.some((r) => r.effect === "allow" && r.operation === "*")) stats.wildcardAllow++;
          if (rules.some((r) => r.effect === "allow" && r.operation !== "*")) stats.otherAllow++;
          if (d.action === "hold") stats.hold++;
          if (d.action === "block") stats.block++;
          if (d.action === "ghost") stats.ghost++;

          expect(d.action).not.toBe("allow");
        },
      ),
      { numRuns: 500 },
    );

    // Non-vacuous: the generators exercised the interesting cases.
    expect(stats.wildcardAllow).toBeGreaterThan(0);
    expect(stats.otherAllow).toBeGreaterThan(0);
    expect(stats.hold).toBeGreaterThan(0);
    expect(stats.block).toBeGreaterThan(0);
    expect(stats.ghost).toBeGreaterThan(0);
  });

  it("sanity: fixed wildcard-allow and other-op-allow sets still do not allow", () => {
    const rules: Rule[] = [
      { id: "w", operation: "*", effect: "allow", reason: "any" },
      { id: "o", operation: "Other", effect: "allow", reason: "other" },
    ];
    const d = decide({ op: opSchema("DeleteAccount"), risk: "destructive", args: {}, rules, ghost: false });
    expect(d.action).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// Property 17: Most restrictive rule wins
// ---------------------------------------------------------------------------

describe("Property 17: Most restrictive rule wins", () => {
  type Action = "allow" | "hold" | "ghost" | "block";
  const rank: Record<Action, number> = { allow: 0, hold: 1, ghost: 2, block: 3 };

  const riskArb: fc.Arbitrary<Risk> = fc.constantFrom("read", "write", "destructive");

  /** Rules with and without conditions, so matching is computed independently via `evaluate`. */
  const anyRuleArb = (name: string): fc.Arbitrary<Rule> =>
    fc.oneof(
      ruleArb(name),
      ruleArb(name).map((r): Rule => {
        const { when: _when, ...rest } = r;
        void _when;
        return rest;
      }),
    );

  /** Oracle for matching, independent of decide's internals. */
  const matches = (r: Rule, name: string, args: unknown): boolean =>
    (r.operation === name || r.operation === "*") &&
    (r.when === undefined ||
      evaluate(r.when, args) === true ||
      (evaluate(r.when, args) === "unknown" && r.effect !== "allow"));

  /**
   * **Validates: Requirements 4.3, 7.1**
   */
  it("decision strictness is >= the strictness of every matching rule's effect", () => {
    const stats = { runs: 0, multiMixed: 0, allow: 0, hold: 0, ghost: 0, block: 0, withCondition: 0 };

    fc.assert(
      fc.property(
        opName.chain((name) =>
          fc.tuple(
            fc.constant(name),
            riskArb,
            fc.array(anyRuleArb(name), { maxLength: 8 }),
            argsArb,
            fc.boolean(),
          ),
        ),
        ([name, risk, rules, args, ghost]) => {
          const d = decide({ op: opSchema(name), risk, args, rules, ghost });
          const matching = rules.filter((r) => matches(r, name, args));
          const effects = new Set(matching.map((r) => r.effect));

          stats.runs++;
          if (matching.length >= 2 && effects.size >= 2) stats.multiMixed++;
          if (matching.some((r) => r.when !== undefined)) stats.withCondition++;
          stats[d.action]++;

          // Core property: decision is never less strict than any matching rule.
          // A matching hold may be replaced by ghost (rank 2 >= 1); allow never lowers.
          for (const r of matching) {
            expect(rank[d.action]).toBeGreaterThanOrEqual(rank[r.effect]);
          }

          // Exact expectations.
          if (matching.some((r) => r.effect === "block")) {
            expect(d.action).toBe("block");
          } else if (ghost && risk !== "read") {
            expect(d.action).toBe("ghost");
          } else if (matching.some((r) => r.effect === "hold")) {
            expect(d.action).toBe("hold");
          }
          // Ghost is only ever produced in ghost mode for non-read calls.
          if (d.action === "ghost") {
            expect(ghost && risk !== "read").toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );

    // Non-vacuous: mixed multi-rule matches, conditions, and all four actions occurred.
    expect(stats.multiMixed).toBeGreaterThan(0);
    expect(stats.withCondition).toBeGreaterThan(0);
    expect(stats.allow).toBeGreaterThan(0);
    expect(stats.hold).toBeGreaterThan(0);
    expect(stats.ghost).toBeGreaterThan(0);
    expect(stats.block).toBeGreaterThan(0);
  });

  it("sanity: block beats hold and allow regardless of order", () => {
    const rules: Rule[] = [
      { id: "a", operation: "*", effect: "allow", reason: "a" },
      { id: "h", operation: "Op", effect: "hold", reason: "h" },
      { id: "b", operation: "Op", effect: "block", reason: "b" },
    ];
    for (const rs of [rules, [...rules].reverse()]) {
      const d = decide({ op: opSchema("Op"), risk: "write", args: {}, rules: rs, ghost: false });
      expect(d.action).toBe("block");
    }
  });
});

// ---------------------------------------------------------------------------
// Property 18: Fail closed on bad conditions
// ---------------------------------------------------------------------------

describe("Property 18: Fail closed on bad conditions", () => {
  type OrderOp = "gt" | "gte" | "lt" | "lte";
  const orderOpArb: fc.Arbitrary<OrderOp> = fc.constantFrom("gt", "gte", "lt", "lte");

  /** Paths that exist in the built args (nested, array index) plus one that is absent. */
  const presentPathArb = fc.constantFrom("amount", "transfer.amount", "a.b.c", "items.0");
  const anyPathArb = fc.oneof(presentPathArb, fc.constantFrom("missing", "x.y.z", "items.9"));

  /** Test-side numeric oracle, independent of policy.ts. */
  const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const isNumericLike = (v: unknown): boolean =>
    (typeof v === "number" && Number.isFinite(v)) ||
    (typeof v === "string" && NUMERIC_RE.test(v.trim()) && Number.isFinite(Number(v.trim())));

  /** Strings that are not numeric after trim. */
  const nonNumericString = fc.oneof(
    fc.constantFrom("", " ", "abc", "Infinity", "-Infinity", "NaN", "0x10", "1,000", "1 000", "1e", "--1", "."),
    fc.string().filter((s) => !isNumericLike(s)),
  );

  /** Condition values / arg values that can never be compared numerically. */
  const nonNumericValue: fc.Arbitrary<unknown> = fc.oneof(
    nonNumericString,
    fc.boolean(),
    fc.constant(null),
    fc.constantFrom(Infinity, -Infinity, NaN),
    fc.constant({}),
    fc.constant([]),
    fc.constant([1]),
    fc.constant({ n: 1 }),
  );

  const numericValue: fc.Arbitrary<number | string> = fc.oneof(
    fc.integer({ min: -1000, max: 100000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer({ min: -1000, max: 1000 }).map((n) => ` ${n} `),
    fc.constantFrom("1000", "1e3", "-5", ".5", "+7"),
  );

  /** Arg value for case (a): numbers, strings, or absent (undefined means do not set). */
  const anyArgValue: fc.Arbitrary<unknown> = fc.oneof(
    fc.double({ noNaN: true }),
    fc.integer(),
    fc.string(),
    fc.constantFrom("1000", "abc", ""),
    fc.constant(undefined),
  );

  /** Build args with `value` at `path`; undefined leaves the path absent. */
  const buildArgs = (path: string, value: unknown): unknown => {
    if (value === undefined) return { other: 1 };
    const segs = path.split(".");
    const make = (i: number): unknown => {
      if (i === segs.length) return value;
      const seg = segs[i];
      if (/^\d+$/.test(seg)) {
        const arr: unknown[] = [];
        arr[Number(seg)] = make(i + 1);
        return arr;
      }
      return { [seg]: make(i + 1) };
    };
    return make(0);
  };

  const cond = (field: string, op: OrderOp, value: unknown): Condition =>
    ({ field, op, value }) as unknown as Condition;

  /**
   * **Validates: Requirements 4.5, 4.6**
   */
  it("(a) a non-numeric condition value makes the rule match for any argument", () => {
    const stats = { runs: 0, absent: 0, numberArg: 0, stringArg: 0, block: 0, hold: 0 };

    fc.assert(
      fc.property(
        anyPathArb,
        orderOpArb,
        nonNumericValue,
        anyArgValue,
        presentPathArb,
        fc.constantFrom<"block" | "hold">("block", "hold"),
        (path, op, condValue, argValue, argPath, effect) => {
          const args = buildArgs(argPath, argValue);
          const when = cond(path, op, condValue);
          expect(holds(when, args)).toBe(true);

          const rule: Rule = { id: "r1", operation: "Transfer", when, effect, reason: "bad cond" };
          const d = decide({ op: opSchema("Transfer"), risk: "write", args, rules: [rule], ghost: false });
          expect(d.action).toBe(effect);
          expect(d.ruleId).toBe("r1");

          stats.runs++;
          if (argValue === undefined) stats.absent++;
          if (typeof argValue === "number") stats.numberArg++;
          if (typeof argValue === "string") stats.stringArg++;
          stats[effect]++;
        },
      ),
      { numRuns: 500 },
    );

    expect(stats.absent).toBeGreaterThan(0);
    expect(stats.numberArg).toBeGreaterThan(0);
    expect(stats.stringArg).toBeGreaterThan(0);
    expect(stats.block).toBeGreaterThan(0);
    expect(stats.hold).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 4.5, 4.6**
   */
  it("(b) a numeric condition value with a non-numeric argument makes the rule match", () => {
    const stats = { runs: 0, block: 0, hold: 0 };

    fc.assert(
      fc.property(
        presentPathArb,
        orderOpArb,
        numericValue,
        nonNumericValue,
        fc.constantFrom<"block" | "hold">("block", "hold"),
        (path, op, condValue, argValue, effect) => {
          const args = buildArgs(path, argValue);
          const when = cond(path, op, condValue);
          expect(holds(when, args)).toBe(true);

          const rule: Rule = { id: "r2", operation: "*", when, effect, reason: "bad arg" };
          const d = decide({ op: opSchema("Transfer"), risk: "write", args, rules: [rule], ghost: false });
          expect(d.action).toBe(effect);

          stats.runs++;
          stats[effect]++;
        },
      ),
      { numRuns: 500 },
    );

    expect(stats.block).toBeGreaterThan(0);
    expect(stats.hold).toBeGreaterThan(0);
  });

  /**
   * Control: the fail-closed result is not vacuous. With finite numbers on both
   * sides the real comparison decides, including false results.
   *
   * **Validates: Requirements 4.5, 4.6**
   */
  it("(c) with finite numbers on both sides, holds equals the real comparison", () => {
    const compare: Record<OrderOp, (a: number, b: number) => boolean> = {
      gt: (a, b) => a > b,
      gte: (a, b) => a >= b,
      lt: (a, b) => a < b,
      lte: (a, b) => a <= b,
    };
    const finite = fc.oneof(
      fc.integer({ min: -5, max: 5 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
    );
    const stats = { truthy: 0, falsy: 0, equalCase: 0 };

    fc.assert(
      fc.property(presentPathArb, orderOpArb, finite, finite, (path, op, actual, expected) => {
        const args = buildArgs(path, actual);
        const result = holds(cond(path, op, expected), args);
        expect(result).toBe(compare[op](actual, expected));

        if (result) stats.truthy++;
        else stats.falsy++;
        if (actual === expected) stats.equalCase++;

        // A rule whose condition evaluates false does not match, so a block rule is inert.
        if (!result) {
          const rule: Rule = { id: "r3", operation: "Transfer", when: cond(path, op, expected), effect: "block", reason: "x" };
          const d = decide({ op: opSchema("Transfer"), risk: "write", args, rules: [rule], ghost: false });
          expect(d.action).toBe("allow");
        }
      }),
      { numRuns: 500 },
    );

    expect(stats.truthy).toBeGreaterThan(0);
    expect(stats.falsy).toBeGreaterThan(0);
    expect(stats.equalCase).toBeGreaterThan(0);
  });

  /**
   * An allow rule whose condition is unevaluable never matches: the decision equals the
   * decision without that rule, and a destructive op is never allowed through it.
   *
   * **Validates: Requirements 4.5, 4.6, 4.7**
   */
  it("(d) allow rules with unevaluable conditions never match", () => {
    const stats = { runs: 0, destructiveHold: 0, nonDestructive: 0, wildcard: 0, explicit: 0 };
    const otherRules: Rule[] = [
      { id: "h", operation: "*", effect: "hold", reason: "h" },
      { id: "b", operation: "Other", effect: "block", reason: "b" },
      { id: "a", operation: "*", effect: "allow", reason: "a" },
    ];
    const badWhen: fc.Arbitrary<Condition> = fc.oneof(
      fc.tuple(fc.constantFrom("missing", "x.y.z", "items.9"), orderOpArb, numericValue).map(([f, o, v]) => cond(f, o, v)),
      fc.tuple(presentPathArb, orderOpArb, nonNumericValue).map(([f, o, v]) => cond(f, o, v)),
      fc.constantFrom("__proto__", "a.__proto__", "constructor", "prototype", "", "a..b").map((f) => cond(f, "gt", 1)),
      fc.constant({ field: "amount", op: "regex", value: "a" } as unknown as Condition),
    );

    fc.assert(
      fc.property(
        opName,
        fc.constantFrom<Risk>("read", "write", "destructive"),
        badWhen,
        fc.boolean(),
        fc.boolean(),
        fc.subarray(otherRules),
        (name, risk, when, wildcard, ghost, others) => {
          // Args contain none of the conditions' fields, so every condition is unevaluable.
          const args = buildArgs("amount", undefined);
          const bad: Rule = { id: "bad", operation: wildcard ? "*" : name, when, effect: "allow", reason: "bad" };
          const o = opSchema(name);
          const withBad = decide({ op: o, risk, args, rules: [bad, ...others], ghost });
          const without = decide({ op: o, risk, args, rules: others, ghost });
          expect(withBad).toEqual(without);
          if (risk === "destructive") expect(withBad.action).not.toBe("allow");

          stats.runs++;
          if (risk === "destructive" && withBad.action === "hold") stats.destructiveHold++;
          if (risk !== "destructive") stats.nonDestructive++;
          if (wildcard) stats.wildcard++;
          else stats.explicit++;
        },
      ),
      { numRuns: 500 },
    );

    expect(stats.destructiveHold).toBeGreaterThan(0);
    expect(stats.nonDestructive).toBeGreaterThan(0);
    expect(stats.wildcard).toBeGreaterThan(0);
    expect(stats.explicit).toBeGreaterThan(0);
  });

  it("(c) absent and nested fields: absent holds, present compares", () => {
    expect(holds(cond("missing", "gt", 5), { amount: 1 })).toBe(true);
    expect(holds(cond("transfer.amount", "gt", 5), { transfer: { amount: 1 } })).toBe(false);
    expect(holds(cond("transfer.amount", "gt", 5), { transfer: { amount: 9 } })).toBe(true);
    expect(holds(cond("transfer.amount", "gt", "abc"), { transfer: { amount: 1 } })).toBe(true);
  });
});
