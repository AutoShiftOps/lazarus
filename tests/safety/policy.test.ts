import { describe, it, expect } from "vitest";
import { decide, getPath, holds } from "../../lib/safety/policy";
import type { OperationSchema, Risk } from "../../lib/soap/types";
import type { CondOp, Condition, Rule } from "../../lib/safety/types";

const op = (name: string): OperationSchema => ({ name }) as unknown as OperationSchema;

const rule = (
  id: string,
  effect: Rule["effect"],
  operation = "Op",
  when?: Condition,
): Rule => ({ id, operation, effect, reason: `reason-${id}`, ...(when ? { when } : {}) });

const run = (risk: Risk, rules: Rule[], args: unknown = {}, ghost = false, name = "Op") =>
  decide({ op: op(name), risk, args, rules, ghost });

const cond = (field: string, o: CondOp, value: string | number | boolean): Condition => ({
  field,
  op: o,
  value,
});

describe("decide: default by risk", () => {
  it("allows read", () => {
    expect(run("read", [])).toEqual({ action: "allow", reason: "Default policy for read operation" });
  });
  it("allows write", () => {
    expect(run("write", [])).toEqual({ action: "allow", reason: "Default policy for write operation" });
  });
  it("holds destructive", () => {
    expect(run("destructive", [])).toEqual({ action: "hold", reason: "Destructive operation" });
  });
});

describe("decide: amount threshold", () => {
  const r = rule("big", "hold", "Transfer", cond("amount", "gt", 1000));
  const nested = rule("bigN", "hold", "Transfer", cond("transfer.amount", "gt", 1000));

  it("holds when amount is above the threshold", () => {
    expect(run("write", [r], { amount: 1000.01 }, false, "Transfer")).toEqual({
      action: "hold",
      ruleId: "big",
      reason: "reason-big",
    });
  });
  it("does not hold when amount equals the threshold", () => {
    expect(run("write", [r], { amount: 1000 }, false, "Transfer")).toEqual({
      action: "allow",
      reason: "Default policy for write operation",
    });
  });
  it("holds on a nested path", () => {
    expect(run("write", [nested], { transfer: { amount: 5000 } }, false, "Transfer")).toEqual({
      action: "hold",
      ruleId: "bigN",
      reason: "reason-bigN",
    });
  });
  it("does not hold on a nested path below the threshold", () => {
    expect(run("write", [nested], { transfer: { amount: 5 } }, false, "Transfer").action).toBe("allow");
  });
  it("holds on a numeric string above the threshold", () => {
    expect(run("write", [r], { amount: "5000.00" }, false, "Transfer").action).toBe("hold");
  });
  it("does not hold on a numeric string below the threshold", () => {
    expect(run("write", [r], { amount: "500" }, false, "Transfer").action).toBe("allow");
  });
});

describe("decide: precedence", () => {
  it("block beats hold regardless of order", () => {
    const h = rule("h", "hold");
    const b = rule("b", "block");
    expect(run("write", [h, b])).toEqual({ action: "block", ruleId: "b", reason: "reason-b" });
    expect(run("write", [b, h])).toEqual({ action: "block", ruleId: "b", reason: "reason-b" });
  });
  it("ghost beats hold for write", () => {
    expect(run("write", [rule("h", "hold")], {}, true)).toEqual({
      action: "ghost",
      reason: "Ghost mode: nothing is sent to the real service",
    });
  });
  it("ghost beats the destructive default hold", () => {
    expect(run("destructive", [], {}, true).action).toBe("ghost");
  });
  it("ghost beats an explicit allow on destructive", () => {
    expect(run("destructive", [rule("a", "allow")], {}, true).action).toBe("ghost");
  });
  it("block beats ghost", () => {
    expect(run("destructive", [rule("b", "block")], {}, true)).toEqual({
      action: "block",
      ruleId: "b",
      reason: "reason-b",
    });
  });
  it("ghost applies to write", () => {
    expect(run("write", [], {}, true).action).toBe("ghost");
  });
  it("ghost applies to destructive", () => {
    expect(run("destructive", [], {}, true).action).toBe("ghost");
  });
  it("ghost does not apply to read", () => {
    expect(run("read", [], {}, true)).toEqual({
      action: "allow",
      reason: "Default policy for read operation",
    });
  });
  it("a hold rule still applies to read in ghost mode", () => {
    expect(run("read", [rule("h", "hold")], {}, true)).toEqual({
      action: "hold",
      ruleId: "h",
      reason: "reason-h",
    });
  });
});

describe("decide: allow rules on destructive", () => {
  it("an explicit allow downgrades the default hold", () => {
    expect(run("destructive", [rule("a", "allow", "Op")])).toEqual({
      action: "allow",
      ruleId: "a",
      reason: "reason-a",
    });
  });
  it("a wildcard allow does not downgrade the default hold", () => {
    expect(run("destructive", [rule("a", "allow", "*")])).toEqual({
      action: "hold",
      reason: "Destructive operation",
    });
  });
  it("a wildcard allow plus an explicit allow uses the explicit one", () => {
    expect(run("destructive", [rule("w", "allow", "*"), rule("e", "allow", "Op")])).toEqual({
      action: "allow",
      ruleId: "e",
      reason: "reason-e",
    });
  });
  it("a hold rule beats an explicit allow in either order", () => {
    const expected = { action: "hold", ruleId: "h", reason: "reason-h" };
    expect(run("destructive", [rule("a", "allow"), rule("h", "hold")])).toEqual(expected);
    expect(run("destructive", [rule("h", "hold"), rule("a", "allow")])).toEqual(expected);
  });
  it("an allow rule on write returns its ruleId", () => {
    expect(run("write", [rule("a", "allow", "*")])).toEqual({
      action: "allow",
      ruleId: "a",
      reason: "reason-a",
    });
  });
});

describe("decide: rule matching", () => {
  it("ignores a rule for another operation", () => {
    expect(run("write", [rule("x", "block", "Other")])).toEqual({
      action: "allow",
      reason: "Default policy for write operation",
    });
  });
  it("applies a wildcard operation rule", () => {
    expect(run("read", [rule("x", "block", "*")])).toEqual({
      action: "block",
      ruleId: "x",
      reason: "reason-x",
    });
  });
  it("reports the first matching block in order", () => {
    expect(run("write", [rule("b1", "block"), rule("b2", "block")]).ruleId).toBe("b1");
  });
  it("reports the first matching hold in order", () => {
    expect(run("write", [rule("h1", "hold"), rule("h2", "hold")]).ruleId).toBe("h1");
  });
  it("reports the first matching allow in order", () => {
    expect(run("write", [rule("a1", "allow"), rule("a2", "allow")]).ruleId).toBe("a1");
  });
  it("skips a first rule whose condition is evaluably false", () => {
    const rules = [
      rule("h1", "hold", "Op", cond("amount", "gt", 100)),
      rule("h2", "hold", "Op", cond("amount", "gt", 10)),
    ];
    expect(run("write", rules, { amount: 50 }).ruleId).toBe("h2");
  });
});

describe("holds: operators", () => {
  const cases: Array<[string, Condition, unknown, boolean]> = [
    ["gt true", cond("x", "gt", 3), { x: 5 }, true],
    ["gt equal", cond("x", "gt", 3), { x: 3 }, false],
    ["gt less", cond("x", "gt", 3), { x: 2 }, false],
    ["gte equal", cond("x", "gte", 3), { x: 3 }, true],
    ["gte less", cond("x", "gte", 3), { x: 2 }, false],
    ["lt less", cond("x", "lt", 3), { x: 2 }, true],
    ["lt equal", cond("x", "lt", 3), { x: 3 }, false],
    ["lte equal", cond("x", "lte", 3), { x: 3 }, true],
    ["lte greater", cond("x", "lte", 3), { x: 4 }, false],
    ["eq string equal", cond("x", "eq", "a"), { x: "a" }, true],
    ["eq string different", cond("x", "eq", "a"), { x: "b" }, false],
    ["eq number equal", cond("x", "eq", 5), { x: 5 }, true],
    ["eq number different", cond("x", "eq", 5), { x: 6 }, false],
    ["eq numeric string vs number", cond("x", "eq", 5), { x: "5" }, true],
    ["eq boolean equal", cond("x", "eq", true), { x: true }, true],
    ["eq boolean different", cond("x", "eq", true), { x: false }, false],
    ["neq different", cond("x", "neq", "a"), { x: "b" }, true],
    ["neq equal", cond("x", "neq", "a"), { x: "a" }, false],
    ["contains string true", cond("x", "contains", "ell"), { x: "hello" }, true],
    ["contains string false", cond("x", "contains", "zzz"), { x: "hello" }, false],
    ["contains array string true", cond("x", "contains", "b"), { x: ["a", "b"] }, true],
    ["contains array string false", cond("x", "contains", "c"), { x: ["a", "b"] }, false],
    ["contains array number true", cond("x", "contains", 2), { x: [1, 2] }, true],
    ["contains array number false", cond("x", "contains", 3), { x: [1, 2] }, false],
    ["contains array boolean true", cond("x", "contains", true), { x: [true] }, true],
  ];

  it.each(cases)("%s", (_name, c, args, expected) => {
    expect(holds(c, args)).toBe(expected);
  });

  it("an absent condition holds", () => {
    expect(holds(undefined, {})).toBe(true);
  });

  it.each(cases.filter((c) => !c[3]))("decide does not match a block rule when evaluably false: %s", (_n, c, args) => {
    expect(run("write", [rule("b", "block", "Op", c)], args)).toEqual({
      action: "allow",
      reason: "Default policy for write operation",
    });
  });
});

describe("holds: fail closed", () => {
  it.each(["gt", "gte", "lt", "lte"] as const)("%s with a non-numeric actual holds", (o) => {
    expect(holds(cond("x", o, 3), { x: "abc" })).toBe(true);
  });
  it.each(["gt", "gte", "lt", "lte"] as const)("%s with an empty-string actual holds", (o) => {
    expect(holds(cond("x", o, 3), { x: "" })).toBe(true);
  });
  it.each(["gt", "gte", "lt", "lte"] as const)("%s with a non-numeric expected value holds", (o) => {
    expect(holds(cond("x", o, "abc"), { x: 5 })).toBe(true);
  });
  it.each(["gt", "gte", "lt", "lte"] as const)("%s with a non-finite actual holds", (o) => {
    expect(holds(cond("x", o, 3), { x: Number.POSITIVE_INFINITY })).toBe(true);
  });
  it.each(["gt", "gte", "lt", "lte", "eq", "neq", "contains"] as const)(
    "%s with an absent field holds",
    (o) => {
      expect(holds(cond("missing", o, 3), { x: 1 })).toBe(true);
    },
  );
  it("an unknown operator holds", () => {
    const c = { field: "x", op: "regex", value: "a" } as unknown as Condition;
    expect(holds(c, { x: "a" })).toBe(true);
  });
  it("a condition whose evaluation throws holds", () => {
    const args = {
      get amount(): number {
        throw new Error("boom");
      },
    };
    expect(holds(cond("amount", "gt", 10), args)).toBe(true);
  });
  it("eq on an object actual holds", () => {
    expect(holds(cond("x", "eq", "a"), { x: {} })).toBe(true);
  });
  it("eq with a boolean/string type mismatch holds", () => {
    expect(holds(cond("x", "eq", "true"), { x: true })).toBe(true);
  });
  it("contains on a number actual holds", () => {
    expect(holds(cond("x", "contains", "a"), { x: 5 })).toBe(true);
  });
  it("decide holds a block rule whose condition throws", () => {
    const args = {
      get amount(): number {
        throw new Error("boom");
      },
    };
    expect(run("read", [rule("b", "block", "Op", cond("amount", "gt", 10))], args)).toEqual({
      action: "block",
      ruleId: "b",
      reason: "reason-b",
    });
  });
  it("decide holds a hold rule on an unknown operator", () => {
    const c = { field: "x", op: "regex", value: "a" } as unknown as Condition;
    expect(run("write", [rule("h", "hold", "Op", c)], { x: "a" })).toEqual({
      action: "hold",
      ruleId: "h",
      reason: "reason-h",
    });
  });
  it("decide holds a hold rule on an absent field", () => {
    expect(run("write", [rule("h", "hold", "Op", cond("nope", "gt", 1))], {}).ruleId).toBe("h");
  });
  it("decide holds a hold rule on non-numeric input", () => {
    expect(run("write", [rule("h", "hold", "Op", cond("amount", "gt", 1))], { amount: "lots" }).ruleId).toBe("h");
  });
});

describe("getPath", () => {
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();

  const expectProtoUntouched = (): void => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoBefore);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  };

  it("reads a top-level and nested own value", () => {
    expect(getPath({ a: { b: 7 } }, "a.b")).toEqual({ kind: "found", value: 7 });
    expect(getPath({ a: 1 }, "a")).toEqual({ kind: "found", value: 1 });
  });
  it("returns a found null value", () => {
    expect(getPath({ a: null }, "a")).toEqual({ kind: "found", value: null });
  });
  it("returns notFound when walking through null", () => {
    expect(getPath({ a: null }, "a.b")).toEqual({ kind: "notFound" });
  });
  it("returns notFound for an absent key", () => {
    expect(getPath({ a: 1 }, "b")).toEqual({ kind: "notFound" });
  });

  it("rejects __proto__ at the top level", () => {
    const args: unknown = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    expect(getPath(args, "__proto__")).toEqual({ kind: "rejected" });
    expect(getPath(args, "__proto__.polluted")).toEqual({ kind: "rejected" });
    expectProtoUntouched();
  });
  it("rejects __proto__ as a nested segment", () => {
    const args: unknown = JSON.parse('{"a":{"__proto__":{"polluted":"yes"}}}');
    expect(getPath(args, "a.__proto__")).toEqual({ kind: "rejected" });
    expect(getPath(args, "a.__proto__.polluted")).toEqual({ kind: "rejected" });
    expectProtoUntouched();
  });
  it("rejects constructor at the top level", () => {
    expect(getPath({ constructor: 1 }, "constructor")).toEqual({ kind: "rejected" });
    expect(getPath({}, "constructor.name")).toEqual({ kind: "rejected" });
  });
  it("rejects constructor as a nested segment", () => {
    expect(getPath({ a: { constructor: 1 } }, "a.constructor")).toEqual({ kind: "rejected" });
    expect(getPath({ a: {} }, "a.constructor.name")).toEqual({ kind: "rejected" });
  });
  it("rejects prototype at the top level", () => {
    expect(getPath({ prototype: 1 }, "prototype")).toEqual({ kind: "rejected" });
    expect(getPath({}, "prototype.x")).toEqual({ kind: "rejected" });
  });
  it("rejects prototype as a nested segment", () => {
    expect(getPath({ a: { prototype: 1 } }, "a.prototype")).toEqual({ kind: "rejected" });
    expect(getPath({ a: {} }, "a.prototype.x")).toEqual({ kind: "rejected" });
  });
  it("rejects a forbidden segment even when an earlier segment is absent", () => {
    expect(getPath({}, "missing.__proto__")).toEqual({ kind: "rejected" });
  });

  it.each(["", "a..b", ".a", "a."])("rejects an empty segment in %j", (p) => {
    expect(getPath({ a: { b: 1 } }, p)).toEqual({ kind: "rejected" });
  });

  it("does not read inherited toString", () => {
    expect(getPath({}, "toString")).toEqual({ kind: "notFound" });
  });
  it("does not read inherited hasOwnProperty", () => {
    expect(getPath({}, "hasOwnProperty")).toEqual({ kind: "notFound" });
  });
  it("does not read inherited properties on nested objects", () => {
    expect(getPath({ a: {} }, "a.toString")).toEqual({ kind: "notFound" });
    expect(getPath({ a: {} }, "a.valueOf")).toEqual({ kind: "notFound" });
  });
  it("does not read from non-plain objects", () => {
    class Box {
      v = 1;
    }
    expect(getPath({ a: new Box() }, "a.v")).toEqual({ kind: "notFound" });
  });
  it("does not walk into strings", () => {
    expect(getPath({ a: "abc" }, "a.length")).toEqual({ kind: "notFound" });
  });

  it("reads array elements by index", () => {
    expect(getPath({ a: [10, 20] }, "a.1")).toEqual({ kind: "found", value: 20 });
    expect(getPath({ a: [{ b: 3 }] }, "a.0.b")).toEqual({ kind: "found", value: 3 });
    expect(getPath([5], "0")).toEqual({ kind: "found", value: 5 });
  });
  it("returns notFound for array length", () => {
    expect(getPath({ a: [10, 20] }, "a.length")).toEqual({ kind: "notFound" });
  });
  it("returns notFound for out-of-range, negative, leading-zero and method array segments", () => {
    expect(getPath({ a: [10, 20] }, "a.2")).toEqual({ kind: "notFound" });
    expect(getPath({ a: [10, 20] }, "a.-1")).toEqual({ kind: "notFound" });
    expect(getPath({ a: [10, 20] }, "a.01")).toEqual({ kind: "notFound" });
    expect(getPath({ a: [10, 20] }, "a.map")).toEqual({ kind: "notFound" });
  });

  it("leaves Object.prototype untouched after all of the above", () => {
    getPath(JSON.parse('{"__proto__":{"polluted":"yes"}}') as unknown, "__proto__.polluted");
    getPath({}, "constructor.prototype.polluted");
    getPath({}, "toString");
    expectProtoUntouched();
  });
});

describe("rules with forbidden or malformed paths", () => {
  const badPaths = ["__proto__", "__proto__.x", "a.__proto__", "constructor", "constructor.name", "a.constructor", "prototype", "a.prototype", "", "a..b"];

  it.each(badPaths)("holds is true for path %j", (p) => {
    expect(holds(cond(p, "eq", "x"), { a: {} })).toBe(true);
  });
  it.each(badPaths)("a block rule with path %j takes effect", (p) => {
    expect(run("read", [rule("b", "block", "Op", cond(p, "eq", "x"))], { a: {} })).toEqual({
      action: "block",
      ruleId: "b",
      reason: "reason-b",
    });
  });
  it.each(badPaths)("a hold rule with path %j takes effect", (p) => {
    expect(run("write", [rule("h", "hold", "Op", cond(p, "eq", "x"))], { a: {} })).toEqual({
      action: "hold",
      ruleId: "h",
      reason: "reason-h",
    });
  });
  it.each(badPaths)("an explicit allow rule with path %j does not match, so destructive still holds", (p) => {
    expect(run("destructive", [rule("a", "allow", "Op", cond(p, "eq", "x"))], { a: {} })).toEqual({
      action: "hold",
      reason: "Destructive operation",
    });
  });
});

describe("unevaluable conditions: fail closed per effect", () => {
  const held = { action: "hold", reason: "Destructive operation" };
  const throwing = {
    get amount(): number {
      throw new Error("boom");
    },
  };
  const unknownOp = { field: "x", op: "regex", value: "a" } as unknown as Condition;

  it("an explicit allow rule with a missing field still holds a destructive op", () => {
    expect(run("destructive", [rule("a", "allow", "Op", cond("missing", "gt", 1))], {})).toEqual(held);
  });
  it("an allow rule with a type mismatch does not match (explicit)", () => {
    const args = { amount: "lots" };
    const c = cond("amount", "gt", 1);
    expect(run("destructive", [rule("a", "allow", "Op", c)], args)).toEqual(held);
    expect(run("destructive", [rule("a", "allow", "Op", c)], args)).toEqual(run("destructive", [], args));
    expect(run("write", [rule("a", "allow", "Op", c)], args)).toEqual(run("write", [], args));
  });
  it("an allow rule with a type mismatch does not match (wildcard)", () => {
    const args = { amount: "lots" };
    const c = cond("amount", "gt", 1);
    expect(run("destructive", [rule("a", "allow", "*", c)], args)).toEqual(held);
    expect(run("write", [rule("a", "allow", "*", c)], args)).toEqual(run("write", [], args));
  });
  it("an allow rule with a throwing getter does not match", () => {
    const rules = [rule("a", "allow", "Op", cond("amount", "gt", 1))];
    expect(run("destructive", rules, throwing)).toEqual(held);
    expect(run("write", rules, throwing)).toEqual({ action: "allow", reason: "Default policy for write operation" });
  });
  it("an allow rule with an unknown operator does not match", () => {
    const rules = [rule("a", "allow", "Op", unknownOp)];
    expect(run("destructive", rules, { x: "a" })).toEqual(held);
    expect(run("write", rules, { x: "a" })).toEqual({ action: "allow", reason: "Default policy for write operation" });
  });
  it("an allow rule with a forbidden path does not match", () => {
    const rules = [rule("a", "allow", "Op", cond("__proto__", "eq", "x"))];
    expect(run("destructive", rules, { a: {} })).toEqual(held);
    expect(run("read", rules, { a: {} })).toEqual({ action: "allow", reason: "Default policy for read operation" });
  });
  it("a hold rule with a missing field still holds", () => {
    expect(run("write", [rule("h", "hold", "Op", cond("missing", "gt", 1))], {})).toEqual({
      action: "hold",
      ruleId: "h",
      reason: "reason-h",
    });
  });
  it("a block rule with a missing field still blocks", () => {
    expect(run("read", [rule("b", "block", "Op", cond("missing", "gt", 1))], {})).toEqual({
      action: "block",
      ruleId: "b",
      reason: "reason-b",
    });
  });
  it("an explicit allow rule with an evaluable true condition still downgrades destructive", () => {
    expect(run("destructive", [rule("a", "allow", "Op", cond("amount", "lt", 10))], { amount: 5 })).toEqual({
      action: "allow",
      ruleId: "a",
      reason: "reason-a",
    });
  });
  it("an explicit allow rule with an evaluable false condition does not match", () => {
    expect(run("destructive", [rule("a", "allow", "Op", cond("amount", "lt", 10))], { amount: 50 })).toEqual(held);
  });
});
