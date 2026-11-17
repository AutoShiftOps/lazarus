import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INTEGER_TYPES,
  NUMBER_TYPES,
  STRING_TYPES,
  buildZodSchema,
  xsdTypeToZod,
} from "../../lib/soap/schema-generator";
const NUM_RUNS = 100;
const dateTimeArb = fc
  .date({
    min: new Date("1970-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());
const dateArb = dateTimeArb.map((s) => s.slice(0, 10));
function validValueArb(type: string): fc.Arbitrary<unknown> {
  if (STRING_TYPES.has(type)) return fc.string();
  if (INTEGER_TYPES.has(type)) return fc.integer();
  if (NUMBER_TYPES.has(type)) return fc.double({ noNaN: true, noDefaultInfinity: true });
  if (type === "boolean") return fc.boolean();
  if (type === "dateTime") return dateTimeArb;
  if (type === "date") return dateArb;
  throw new Error(`No arbitrary for type ${type}`);
}
const SUPPORTED_TYPES: string[] = [
  ...STRING_TYPES,
  ...INTEGER_TYPES,
  ...NUMBER_TYPES,
  "boolean",
  "dateTime",
  "date",
];
describe("Property 8: XSD type mapping completeness", () => {
  it("covers a non-empty set of supported types", () => {
    expect(SUPPORTED_TYPES.length).toBeGreaterThan(0);
  });
  for (const type of SUPPORTED_TYPES) {
    it(`maps ${type} to a real schema that accepts valid values`, () => {
      fc.assert(
        fc.property(validValueArb(type), (value) => {
          const { schema, warning } = xsdTypeToZod(type);
          expect(warning).toBeUndefined();
          expect(schema instanceof z.ZodUnknown).toBe(false);
          expect(schema.safeParse(value).success).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  }
});
describe("Property 9: Schema modifiers preserve value semantics", () => {
  const modifiersArb = fc.record({
    minOccurs: fc.constantFrom(0, 1),
    nillable: fc.boolean(),
    maxOccurs: fc.constantFrom<number | "unbounded">(1, 2, 5, "unbounded"),
  });
  it("accepts exactly the expected value set", () => {
    fc.assert(
      fc.property(
        modifiersArb,
        fc.string(),
        fc.array(fc.string(), { maxLength: 5 }),
        (mods, str, strs) => {
          const schema = buildZodSchema([
            { name: "f", xsdType: "string", ...mods },
          ]);
          const isArray = mods.maxOccurs === "unbounded" || mods.maxOccurs > 1;
          // missing key iff minOccurs 0
          expect(schema.safeParse({}).success).toBe(mods.minOccurs === 0);
          // null iff nillable
          expect(schema.safeParse({ f: null }).success).toBe(mods.nillable);
          // array of strings iff maxOccurs > 1
          expect(schema.safeParse({ f: strs }).success).toBe(isArray);
          // bare string iff not array
          expect(schema.safeParse({ f: str }).success).toBe(!isArray);
          // wrong shapes
          expect(schema.safeParse({ f: isArray ? str : strs }).success).toBe(false);
          // wrong element type
          expect(schema.safeParse({ f: isArray ? [1] : 1 }).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
