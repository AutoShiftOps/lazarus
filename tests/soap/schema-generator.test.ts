import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseWsdl } from "../../lib/soap/parser";
import {
  buildZodSchema,
  generateSchemas,
  xsdTypeToZod,
} from "../../lib/soap/schema-generator";
import type {
  FieldDescriptor,
  OperationSchema,
  ServiceDefinition,
} from "../../lib/soap/types";

function field(over: Partial<FieldDescriptor> & { name: string }): FieldDescriptor {
  return { xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false, ...over };
}

function ok(xsdType: string, value: unknown): boolean {
  return xsdTypeToZod(xsdType).schema.safeParse(value).success;
}

const STRING_ALIASES = [
  "string", "normalizedString", "token", "anyURI", "base64Binary", "hexBinary",
  "time", "duration", "language", "Name", "NCName", "ID", "QName",
];
const INT_TYPES = [
  "int", "integer", "long", "short", "byte", "unsignedByte", "unsignedShort",
  "unsignedInt", "unsignedLong", "nonNegativeInteger", "positiveInteger",
  "nonPositiveInteger", "negativeInteger",
];

describe("xsdTypeToZod (Requirement 4.3)", () => {
  it.each(STRING_ALIASES)("%s accepts strings and rejects numbers", (t) => {
    expect(ok(t, "abc")).toBe(true);
    expect(ok(t, 5)).toBe(false);
    expect(xsdTypeToZod(t).warning).toBeUndefined();
  });

  it.each(INT_TYPES)("%s accepts integers and rejects fractions/strings", (t) => {
    expect(ok(t, 7)).toBe(true);
    expect(ok(t, 1.5)).toBe(false);
    expect(ok(t, "7")).toBe(false);
    expect(xsdTypeToZod(t).warning).toBeUndefined();
  });

  it.each(["decimal", "float", "double"])("%s accepts fractions and rejects strings", (t) => {
    expect(ok(t, 1.5)).toBe(true);
    expect(ok(t, "1.5")).toBe(false);
  });

  it("boolean accepts booleans and rejects strings", () => {
    expect(ok("boolean", true)).toBe(true);
    expect(ok("boolean", "true")).toBe(false);
  });

  it("dateTime accepts offset and local forms", () => {
    expect(ok("dateTime", "2024-01-02T03:04:05Z")).toBe(true);
    expect(ok("dateTime", "2024-01-02T03:04:05+02:00")).toBe(true);
    expect(ok("dateTime", "2024-01-02T03:04:05")).toBe(true);
    expect(ok("dateTime", "yesterday")).toBe(false);
    expect(ok("dateTime", 123)).toBe(false);
  });

  it("date accepts YYYY-MM-DD with optional Z or offset", () => {
    expect(ok("date", "2024-01-02")).toBe(true);
    expect(ok("date", "2024-01-02Z")).toBe(true);
    expect(ok("date", "2024-01-02+05:30")).toBe(true);
    expect(ok("date", "2024-01-02-08:00")).toBe(true);
    expect(ok("date", "01/02/2024")).toBe(false);
    expect(ok("date", "2024-1-2")).toBe(false);
  });

  it("unmapped type falls back to unknown with warning equal to the type name", () => {
    const r = xsdTypeToZod("gYearMonth");
    expect(r.warning).toBe("gYearMonth");
    expect(r.schema.safeParse({ any: "thing" }).success).toBe(true);
  });

  it.each(["anyType", "complexType", "unknown"])("%s maps to unknown without warning", (t) => {
    const r = xsdTypeToZod(t);
    expect(r.warning).toBeUndefined();
    expect(r.schema.safeParse(42).success).toBe(true);
  });
});

describe("buildZodSchema (Requirements 4.4, 4.5)", () => {
  const parse = (f: FieldDescriptor, v: unknown) =>
    buildZodSchema([f]).safeParse({ x: v }).success;
  const parseMissing = (f: FieldDescriptor) => buildZodSchema([f]).safeParse({}).success;

  it("required field rejects missing and null", () => {
    const f = field({ name: "x" });
    expect(parse(f, "a")).toBe(true);
    expect(parseMissing(f)).toBe(false);
    expect(parse(f, null)).toBe(false);
  });

  it("minOccurs 0 makes the field optional but not nullable", () => {
    const f = field({ name: "x", minOccurs: 0 });
    expect(parseMissing(f)).toBe(true);
    expect(parse(f, "a")).toBe(true);
    expect(parse(f, null)).toBe(false);
  });

  it("nillable makes the field nullable but not optional", () => {
    const f = field({ name: "x", nillable: true });
    expect(parse(f, null)).toBe(true);
    expect(parse(f, "a")).toBe(true);
    expect(parseMissing(f)).toBe(false);
  });

  it("minOccurs 0 and nillable allow both missing and null", () => {
    const f = field({ name: "x", minOccurs: 0, nillable: true });
    expect(parseMissing(f)).toBe(true);
    expect(parse(f, null)).toBe(true);
    expect(parse(f, "a")).toBe(true);
    expect(parse(f, 1)).toBe(false);
  });

  it.each([2, 5, "unbounded" as const])("maxOccurs %s wraps in an array", (maxOccurs) => {
    const f = field({ name: "x", xsdType: "int", maxOccurs });
    expect(parse(f, [1, 2])).toBe(true);
    expect(parse(f, [])).toBe(true);
    expect(parse(f, 1)).toBe(false);
    expect(parse(f, ["a"])).toBe(false);
  });

  it("array combined with optional", () => {
    const f = field({ name: "x", xsdType: "int", maxOccurs: "unbounded", minOccurs: 0 });
    expect(parseMissing(f)).toBe(true);
    expect(parse(f, [1])).toBe(true);
    expect(parse(f, 1)).toBe(false);
  });

  it("maxOccurs 1 does not produce an array", () => {
    const f = field({ name: "x", xsdType: "int" });
    expect(parse(f, [1])).toBe(false);
    expect(parse(f, 1)).toBe(true);
  });

  it("builds nested objects from children", () => {
    const schema = buildZodSchema([
      field({
        name: "outer",
        children: [
          field({ name: "n", xsdType: "int" }),
          field({ name: "inner", children: [field({ name: "s", minOccurs: 0 })] }),
        ],
      }),
    ]);
    expect(schema.safeParse({ outer: { n: 1, inner: {} } }).success).toBe(true);
    expect(schema.safeParse({ outer: { n: "1", inner: {} } }).success).toBe(false);
    expect(schema.safeParse({ outer: { n: 1 } }).success).toBe(false);
  });

  it("rejects extra keys at top level and nested", () => {
    const schema = buildZodSchema([
      field({ name: "o", children: [field({ name: "n", xsdType: "int" })] }),
    ]);
    expect(schema.safeParse({ o: { n: 1 } }).success).toBe(true);
    expect(schema.safeParse({ o: { n: 1 }, extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ o: { n: 1, extra: 1 } }).success).toBe(false);
  });

  it("repeated complex children become arrays of objects", () => {
    const schema = buildZodSchema([
      field({
        name: "items",
        maxOccurs: "unbounded",
        children: [field({ name: "id", xsdType: "int" })],
      }),
    ]);
    expect(schema.safeParse({ items: [{ id: 1 }, { id: 2 }] }).success).toBe(true);
    expect(schema.safeParse({ items: { id: 1 } }).success).toBe(false);
  });
});

describe("JSON Schema for calculator Add", () => {
  it("produces an object schema with integer intA and intB, both required", async () => {
    const r = await parseWsdl(readFileSync("fixtures/calculator.wsdl", "utf8"));
    if (!r.ok) throw new Error(r.error.message);
    const add = r.definition.ports[0].operations.find((o) => o.name === "Add");
    if (!add) throw new Error("Add operation missing");
    const js = z.toJSONSchema(buildZodSchema(add.inputDescriptor)) as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(js.type).toBe("object");
    expect(Object.keys(js.properties).sort()).toEqual(["intA", "intB"]);
    expect(js.properties.intA.type).toBe("integer");
    expect(js.properties.intB.type).toBe("integer");
    expect([...js.required].sort()).toEqual(["intA", "intB"]);
  });
});

function makeOp(name: string, over: Partial<OperationSchema> = {}): OperationSchema {
  return {
    name,
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: `urn:${name}`,
    targetNamespace: "urn:t",
    inputElementName: name,
    outputElementName: `${name}Response`,
    endpointAddress: "http://example.com/svc",
    elementFormDefault: "qualified",
    inputDescriptor: [field({ name: "a", xsdType: "int" })],
    outputDescriptor: [field({ name: "r", xsdType: "int" })],
    warnings: [],
    ...over,
  };
}

function makeService(ports: OperationSchema[][]): ServiceDefinition {
  return {
    name: "S",
    wsdlUrl: "http://example.com/s?wsdl",
    warnings: [],
    ports: ports.map((operations, i) => ({
      name: `P${i}`,
      address: "http://example.com/svc",
      operations,
    })),
  };
}

describe("generateSchemas (Requirements 4.1, 4.6)", () => {
  it("does not mutate its input and returns independent copies", () => {
    const svc = makeService([
      [makeOp("Add", { inputDescriptor: [field({ name: "a", xsdType: "weird" })] })],
    ]);
    const before = structuredClone(svc);
    const out = generateSchemas(svc);
    expect(svc).toEqual(before);

    const op = out.get("Add");
    if (!op) throw new Error("missing Add");
    op.warnings.push({ code: "X", message: "y" });
    op.inputDescriptor[0].name = "changed";
    expect(svc).toEqual(before);
  });

  it("de-duplicates repeated operation names across ports", () => {
    const out = generateSchemas(makeService([[makeOp("Add")], [makeOp("Add")]]));
    expect([...out.keys()]).toEqual(["Add", "Add_2"]);
  });

  it("covers every operation in every port", () => {
    const out = generateSchemas(makeService([[makeOp("A"), makeOp("B")], [makeOp("C")]]));
    expect([...out.keys()]).toEqual(["A", "B", "C"]);
  });

  it("appends XSD_TYPE_UNMAPPED once per type name, including nested and output types", () => {
    const op = makeOp("Op", {
      inputDescriptor: [
        field({ name: "a", xsdType: "gDay" }),
        field({ name: "b", xsdType: "gDay" }),
        field({
          name: "c",
          xsdType: "Complex",
          children: [field({ name: "d", xsdType: "gMonth" })],
        }),
        field({ name: "e", xsdType: "anyType" }),
      ],
      outputDescriptor: [
        field({ name: "f", xsdType: "gMonth" }),
        field({ name: "g", xsdType: "gYear" }),
      ],
    });
    const out = generateSchemas(makeService([[op]]));
    const warnings = out.get("Op")?.warnings ?? [];
    expect(warnings.every((w) => w.code === "XSD_TYPE_UNMAPPED")).toBe(true);
    expect(warnings).toHaveLength(3);
    const text = warnings.map((w) => w.message).join("|");
    for (const t of ["gDay", "gMonth", "gYear"]) {
      expect(text.split(`XSD type ${t} `).length - 1).toBe(1);
    }
    expect(text).not.toContain("anyType");
    expect(warnings.every((w) => w.message.length <= 200)).toBe(true);
  });

  it("does not duplicate a warning already present on the operation", () => {
    const message = "XSD type gDay is not mapped; treated as unknown.";
    const op = makeOp("Op", {
      inputDescriptor: [field({ name: "a", xsdType: "gDay" })],
      warnings: [{ code: "XSD_TYPE_UNMAPPED", message }],
    });
    const out = generateSchemas(makeService([[op]]));
    expect(out.get("Op")?.warnings).toHaveLength(1);
  });
});
