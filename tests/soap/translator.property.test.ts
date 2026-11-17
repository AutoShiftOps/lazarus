import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { XMLValidator } from "fast-xml-parser";
import { fromEnvelope, toEnvelope } from "../../lib/soap/translator";
import type { FieldDescriptor, OperationSchema, SoapVersion } from "../../lib/soap/types";

// ─── Schema builders ──────────────────────────────────────────────────────────

function field(name: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { name, xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false, ...extra };
}

/** Output descriptor equals input descriptor so fromEnvelope can read what toEnvelope wrote. */
function schemaOf(
  descriptor: FieldDescriptor[],
  version: SoapVersion,
  extra: Partial<OperationSchema> = {},
): OperationSchema {
  return {
    name: "Op",
    soapVersions: [version],
    preferredVersion: version,
    bindingStyle: "document/literal",
    soapAction: "http://tempuri.org/Op",
    targetNamespace: "http://tempuri.org/",
    inputElementName: "Op",
    outputElementName: "Op",
    endpointAddress: "http://example.com/svc",
    elementFormDefault: "qualified",
    inputDescriptor: descriptor,
    outputDescriptor: descriptor,
    warnings: [],
    ...extra,
  };
}

const flatDescriptor: FieldDescriptor[] = [
  field("intA", { xsdType: "int" }),
  field("intB", { xsdType: "int" }),
];

const mixedDescriptor: FieldDescriptor[] = [
  field("name"),
  field("active", { xsdType: "boolean" }),
  field("price", { xsdType: "double" }),
  field("note", { minOccurs: 0, nillable: true }),
  field("tags", { maxOccurs: "unbounded" }),
  field("created", { xsdType: "dateTime" }),
];

const nestedDescriptor: FieldDescriptor[] = [
  field("order", {
    xsdType: "OrderType",
    children: [
      field("id", { xsdType: "int" }),
      field("lines", {
        xsdType: "LineType",
        maxOccurs: "unbounded",
        children: [field("sku"), field("qty", { xsdType: "int" })],
      }),
    ],
  }),
];

// ─── Arbitraries (values valid for the schema only) ───────────────────────────

// Legal XML 1.0 characters, excluding CR and surrogates.
const xmlChar: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("\t", "\n"),
  fc.integer({ min: 0x20, max: 0xd7ff }).map((c) => String.fromCharCode(c)),
  fc.integer({ min: 0xe000, max: 0xfffd }).map((c) => String.fromCharCode(c)),
);

const plainString: fc.Arbitrary<string> = fc.string({ unit: xmlChar, maxLength: 20 });

const markupChar: fc.Arbitrary<string> = fc.constantFrom("<", ">", "&", '"', "'", " ");

/** Strings heavy in markup characters, with spaces at both ends. */
const markupString: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.oneof(markupChar, xmlChar), { maxLength: 15 }),
    fc.constantFrom("", " ", "  "),
    fc.constantFrom("", " ", "  "),
  )
  .map(([chars, lead, trail]) => lead + chars.join("") + trail);

const anyString: fc.Arbitrary<string> = fc.oneof(plainString, markupString);

const intValue = fc.integer();

const doubleValue = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .filter((v) => !Object.is(v, -0));

const dateTimeValue = fc
  .date({ min: new Date("1970-01-01T00:00:00.000Z"), max: new Date("2999-12-31T23:59:59.999Z"), noInvalidDate: true })
  .map((d) => d.toISOString());

const flatArgs = fc.record({ intA: intValue, intB: intValue });

// Repeating-field arrays are generated with length 1..4, never empty. XML cannot
// represent an empty list: toEnvelope emits no elements for [], and fromEnvelope
// omits the key (Requirement 5.4), so [] and an absent field are indistinguishable
// on the wire. That limitation is covered by an explicit unit test below.
const mixedArgs = fc.record(
  {
    name: anyString,
    active: fc.boolean(),
    price: doubleValue,
    note: fc.option(anyString, { nil: null }),
    tags: fc.array(anyString, { minLength: 1, maxLength: 4 }),
    created: dateTimeValue,
  },
  { requiredKeys: ["name", "active", "price", "tags", "created"] },
);

const nestedArgs = fc.record({
  order: fc.record({
    id: intValue,
    lines: fc.array(fc.record({ sku: anyString, qty: intValue }), { minLength: 1, maxLength: 4 }),
  }),
});

// ─── Property 1 ───────────────────────────────────────────────────────────────

const VERSIONS: SoapVersion[] = ["1.1", "1.2"];

function roundTrip(args: unknown, schema: OperationSchema): void {
  const env = toEnvelope(args, schema);
  expect(env.ok).toBe(true);
  if (!env.ok) return;
  const parsed = fromEnvelope(env.xml, schema);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.data).toEqual(args);
  expect(parsed.warnings).toEqual([]);
}

describe("Property 1: translator round-trip identity", () => {
  /** **Validates: Requirements 5.5** */
  for (const version of VERSIONS) {
    it(`A) flat document/literal qualified, SOAP ${version}`, () => {
      const schema = schemaOf(flatDescriptor, version);
      fc.assert(
        fc.property(flatArgs, (args) => roundTrip(args, schema)),
        { numRuns: 200 },
      );
    });

    it(`B) mixed document/literal unqualified, SOAP ${version}`, () => {
      const schema = schemaOf(mixedDescriptor, version, { elementFormDefault: "unqualified" });
      fc.assert(
        fc.property(mixedArgs, (args) => roundTrip(args, schema)),
        { numRuns: 200 },
      );
    });

    it(`C) nested rpc/literal, SOAP ${version}`, () => {
      const schema = schemaOf(nestedDescriptor, version, { bindingStyle: "rpc/literal" });
      fc.assert(
        fc.property(nestedArgs, (args) => roundTrip(args, schema)),
        { numRuns: 200 },
      );
    });
  }
});

describe("Empty repeating fields", () => {
  it("empty list is indistinguishable from an absent field (documented limitation)", () => {
    // Schema B: top-level repeating field "tags"
    const schemaB = schemaOf(mixedDescriptor, "1.1", { elementFormDefault: "unqualified" });
    const argsB = { name: "n", active: true, price: 1.5, tags: [], created: "2020-01-01T00:00:00.000Z" };
    const envB = toEnvelope(argsB, schemaB);
    expect(envB.ok).toBe(true);
    if (!envB.ok) return;
    expect(envB.xml).not.toContain("<tags");
    const parsedB = fromEnvelope(envB.xml, schemaB);
    expect(parsedB.ok).toBe(true);
    if (!parsedB.ok) return;
    expect("tags" in (parsedB.data as Record<string, unknown>)).toBe(false);
    const { tags: _omitted, ...withoutTags } = argsB;
    void _omitted;
    expect(parsedB.data).toEqual(withoutTags);

    // Schema C: nested repeating field "order.lines"
    const schemaC = schemaOf(nestedDescriptor, "1.2", { bindingStyle: "rpc/literal" });
    const argsC = { order: { id: 7, lines: [] } };
    const envC = toEnvelope(argsC, schemaC);
    expect(envC.ok).toBe(true);
    if (!envC.ok) return;
    expect(envC.xml).not.toContain("<lines");
    const parsedC = fromEnvelope(envC.xml, schemaC);
    expect(parsedC.ok).toBe(true);
    if (!parsedC.ok) return;
    const order = (parsedC.data as { order: Record<string, unknown> }).order;
    expect("lines" in order).toBe(false);
    expect(parsedC.data).toEqual({ order: { id: 7 } });
  });
});

// ─── Property 2 (escaping) ────────────────────────────────────────────────────

describe("Envelope escaping of arbitrary string values", () => {
  /** **Validates: Requirements 5.7** */
  it("is well-formed XML and adds no '<' beyond the markup built for the value 'x'", () => {
    const schema = schemaOf([field("value")], "1.1");
    const countLt = (s: string): number => s.split("<").length - 1;
    const baseline = toEnvelope({ value: "x" }, schema);
    if (!baseline.ok) throw new Error("baseline envelope failed");

    fc.assert(
      fc.property(anyString, (s) => {
        const env = toEnvelope({ value: s }, schema);
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(XMLValidator.validate(env.xml)).toBe(true);
        expect(countLt(env.xml)).toBe(countLt(baseline.xml));
      }),
      { numRuns: 200 },
    );
  });
});
