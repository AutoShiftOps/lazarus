import { describe, expect, it } from "vitest";
import { formatCents, parseAmountToCents } from "../../lib/gravewood/money";

describe("parseAmountToCents", () => {
  it.each([
    ["5", 500],
    ["5.5", 550],
    ["00012.50", 1250],
    ["999999999999.99", 99999999999999],
  ])("parses %j to %d", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each([
    "0",
    "0.00",
    "-1",
    "1.234",
    "1e3",
    " 5",
    "5 ",
    "",
    "abc",
    "5.",
    ".5",
    "1000000000000",
    "\u0663",
    "1,000",
  ])("rejects %j", (input) => {
    expect(parseAmountToCents(input)).toBeNull();
  });

  it("returns null for non-strings", () => {
    for (const v of [5, null, undefined, {}, [], true]) {
      expect(parseAmountToCents(v as unknown as string)).toBeNull();
    }
  });
});

describe("formatCents", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [100, "1.00"],
    [1245000, "12450.00"],
  ])("formats %d as %s", (c, expected) => {
    expect(formatCents(c)).toBe(expected);
  });

  it.each([1.5, -1, 10 ** 14 + 1, NaN, Infinity])("throws RangeError for %s", (c) => {
    expect(() => formatCents(c)).toThrow(RangeError);
  });
});
