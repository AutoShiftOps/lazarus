// Feature: seance-ui, Property 31: Form arguments validate
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildZodSchema } from "../../lib/soap/schema-generator";
import type { FieldDescriptor } from "../../lib/soap/types";
import { FormError, toArguments, toFormModel } from "../../lib/ui/form-model";

const NAMES = ["a", "b", "c", "d", "e", "f"] as const;
const LEAF_TYPES = ["string", "int", "double", "boolean", "dateTime", "date"] as const;
const MAX_DEPTH = 3;
const MAX_LIST_ITEMS = 3;

function isList(d: FieldDescriptor): boolean {
  return d.maxOccurs === "unbounded" || d.maxOccurs > 1;
}

// ─── Descriptor generators ───────────────────────────────────────────────────

function fieldDescriptor(name: string, depth: number): fc.Arbitrary<FieldDescriptor> {
  const kinds: readonly string[] = depth < MAX_DEPTH - 1 ? [...LEAF_TYPES, "group"] : LEAF_TYPES;
  return fc
    .record({
      kind: fc.constantFrom(...kinds),
      minOccurs: fc.constantFrom(0, 1),
      maxOccurs: fc.constantFrom<number | "unbounded">(1, 1, MAX_LIST_ITEMS, "unbounded"),
      nillable: fc.boolean(),
    })
    .chain((m): fc.Arbitrary<FieldDescriptor> => {
      const base = {
        name,
        minOccurs: m.minOccurs,
        maxOccurs: m.maxOccurs,
        nillable: m.nillable,
      };
      if (m.kind === "group") {
        return descriptorLevel(depth + 1).map((children) => ({
          ...base,
          xsdType: "complexType",
          children,
        }));
      }
      return fc.constant({ ...base, xsdType: m.kind });
    });
}

function descriptorLevel(depth: number): fc.Arbitrary<FieldDescriptor[]> {
  return fc
    .uniqueArray(fc.constantFrom(...NAMES), { maxLength: 6 })
    .chain((names) => fc.tuple(...names.map((n) => fieldDescriptor(n, depth))));
}

// ─── Value generators ────────────────────────────────────────────────────────

const isoDate = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

const plainDate = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));

function leafJson(xsdType: string): fc.Arbitrary<unknown> {
  switch (xsdType) {
    case "date":
      return plainDate;
    case "int":
      return fc.integer();
    case "double":
      return fc.double({ noNaN: true, noDefaultInfinity: true });
    case "boolean":
      return fc.boolean();
    case "dateTime":
      return isoDate;
    default:
      return fc.string();
  }
}

/** One schema-valid occurrence of a field (no list wrapper, no optional/nullable). */
function singleJson(d: FieldDescriptor): fc.Arbitrary<unknown> {
  if (d.children) return objectJson(d.children);
  return leafJson(d.xsdType);
}

/** Schema-valid JSON for a full field, honouring list, nillable and optional. */
function fieldJson(d: FieldDescriptor): fc.Arbitrary<unknown> {
  let arb: fc.Arbitrary<unknown> = isList(d)
    ? fc.array(singleJson(d), { maxLength: MAX_LIST_ITEMS })
    : singleJson(d);
  if (d.nillable) arb = fc.oneof(arb, fc.constant(null));
  if (d.minOccurs === 0) arb = fc.oneof(arb, fc.constant(undefined));
  return arb;
}

function objectJson(children: FieldDescriptor[]): fc.Arbitrary<Record<string, unknown>> {
  return fc.record(Object.fromEntries(children.map((c) => [c.name, fieldJson(c)])));
}

/** Raw form value a user could enter for this field such that the result is valid. */
function formValue(d: FieldDescriptor): fc.Arbitrary<unknown> {
  const required = d.minOccurs >= 1;
  const options: fc.Arbitrary<unknown>[] = [];

  if (isList(d)) {
    options.push(
      fc.array(singleJson(d), { maxLength: MAX_LIST_ITEMS }).map((a) => JSON.stringify(a)),
      fc.constant(""),
      fc.constant(undefined),
    );
  } else if (d.children) {
    options.push(
      fc.record(Object.fromEntries(d.children.map((c) => [c.name, formValue(c)]))),
    );
    if (!required) options.push(fc.constant(undefined));
  } else {
    const typed = leafJson(d.xsdType);
    switch (d.xsdType) {
      case "int":
      case "double":
        options.push(typed, typed.map((n) => String(n)));
        break;
      case "boolean":
        options.push(typed, typed.map((b) => String(b)));
        break;
      default:
        options.push(typed);
    }
    if (!required) options.push(fc.constant(undefined), fc.constant(""));
  }
  if (d.nillable) options.push(fc.constant(null));
  return fc.oneof(...options);
}

const descriptorWithValues = descriptorLevel(0).chain((desc) =>
  fc
    .record(Object.fromEntries(desc.map((d) => [d.name, formValue(d)])))
    .map((values) => ({ desc, values })),
);

// ─── Property 31 ─────────────────────────────────────────────────────────────

describe("Property 31: Form arguments validate", () => {
  it("toArguments output passes buildZodSchema(desc)", () => {
    // **Validates: Requirements 4.1, 4.2**
    fc.assert(
      fc.property(descriptorWithValues, ({ desc, values }) => {
        const args = toArguments(toFormModel(desc), values);
        const result = buildZodSchema(desc).safeParse(args);
        expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
          true,
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Examples ────────────────────────────────────────────────────────────────

function field(
  name: string,
  xsdType: string,
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor {
  return { name, xsdType, minOccurs: 1, maxOccurs: 1, nillable: false, ...extra };
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("toArguments list JSON errors", () => {
  const listDesc = [field("ids", "int", { maxOccurs: "unbounded" })];

  it("throws FormError (not SyntaxError) naming the field for malformed JSON", () => {
    const err = catchError(() => toArguments(toFormModel(listDesc), { ids: "[1, 2" }));
    expect(err).toBeInstanceOf(FormError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as FormError).field).toBe("ids");
    expect((err as FormError).message).toContain("ids");
  });

  it("throws FormError when the JSON is not an array", () => {
    const err = catchError(() => toArguments(toFormModel(listDesc), { ids: "5" }));
    expect(err).toBeInstanceOf(FormError);
    expect((err as FormError).field).toBe("ids");
  });

  it("uses a dotted path for nested list fields", () => {
    const desc = [field("outer", "complexType", { children: listDesc })];
    const err = catchError(() => toArguments(toFormModel(desc), { outer: { ids: "{" } }));
    expect(err).toBeInstanceOf(FormError);
    expect((err as FormError).field).toBe("outer.ids");
  });

  it("parses a valid JSON array", () => {
    expect(toArguments(toFormModel(listDesc), { ids: "[1, 2]" })).toEqual({ ids: [1, 2] });
  });
});

describe("toArguments date fields", () => {
  const desc = [field("born", "date"), field("seen", "date", { minOccurs: 0 })];

  it("maps xsd:date to the date kind and keeps datetime unchanged", () => {
    expect(toFormModel([field("d", "date"), field("t", "dateTime")]).map((f) => f.kind)).toEqual([
      "date",
      "datetime",
    ]);
  });

  it("keeps a valid date as the YYYY-MM-DD string", () => {
    const args = toArguments(toFormModel(desc), { born: "2024-02-29" });
    expect(args).toEqual({ born: "2024-02-29" });
    expect(buildZodSchema(desc).safeParse(args).success).toBe(true);
  });

  it("drops an empty optional date", () => {
    expect(toArguments(toFormModel(desc), { born: "2000-01-01", seen: "" })).toEqual({
      born: "2000-01-01",
    });
  });

  it("throws FormError naming the field for an invalid date", () => {
    for (const bad of ["2025-02-30", "2023-02-29", "2025-13-01", "01/02/2025", "abc"]) {
      const err = catchError(() => toArguments(toFormModel(desc), { born: "2000-01-01", seen: bad }));
      expect(err).toBeInstanceOf(FormError);
      expect((err as FormError).field).toBe("seen");
    }
  });
});

describe("toArguments drops empty optionals", () => {
  const desc = [
    field("name", "string"),
    field("note", "string", { minOccurs: 0 }),
    field("count", "int", { minOccurs: 0 }),
    field("flag", "boolean", { minOccurs: 0 }),
    field("tags", "string", { minOccurs: 0, maxOccurs: "unbounded" }),
    field("extra", "complexType", {
      minOccurs: 0,
      children: [field("x", "string", { minOccurs: 0 })],
    }),
    field("gone", "string", { minOccurs: 0 }),
  ];

  it("omits blank optional fields and keeps required ones", () => {
    const args = toArguments(toFormModel(desc), {
      name: "Ada",
      note: "",
      count: "  ",
      flag: "",
      tags: "",
      extra: { x: "" },
      gone: null,
    });
    expect(args).toEqual({ name: "Ada" });
    expect(buildZodSchema(desc).safeParse(args).success).toBe(true);
  });

  it("converts number strings and keeps explicit null on nillable fields", () => {
    const d = [
      field("count", "int"),
      field("maybe", "string", { nillable: true, minOccurs: 0 }),
    ];
    expect(toArguments(toFormModel(d), { count: "42", maybe: null })).toEqual({
      count: 42,
      maybe: null,
    });
  });

  it("emits an empty array for an empty required list", () => {
    const d = [field("ids", "int", { maxOccurs: "unbounded" })];
    expect(toArguments(toFormModel(d), { ids: "" })).toEqual({ ids: [] });
  });
});
