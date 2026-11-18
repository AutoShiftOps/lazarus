import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ghostResponse } from "../../lib/safety/ghost";
import { parseWsdl } from "../../lib/soap/parser";
import {
  INTEGER_TYPES,
  NUMBER_TYPES,
  STRING_TYPES,
  buildZodSchema,
  generateSchemas,
  xsdTypeToZod,
} from "../../lib/soap/schema-generator";
import type { FieldDescriptor, OperationSchema } from "../../lib/soap/types";

function field(over: Partial<FieldDescriptor> & { name: string }): FieldDescriptor {
  return { xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false, ...over };
}

function makeOp(outputDescriptor: FieldDescriptor[]): OperationSchema {
  return {
    name: "Op",
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: "urn:Op",
    targetNamespace: "urn:test",
    inputElementName: "Op",
    outputElementName: "OpResponse",
    endpointAddress: "http://example.test/svc",
    elementFormDefault: "qualified",
    inputDescriptor: [],
    outputDescriptor,
    warnings: [],
    risk: "read",
    riskReason: "test",
    riskSource: "heuristic",
  };
}

const FIXTURES = ["gravewood", "calculator", "countryinfo"] as const;

describe("ghostResponse validates against generated output schemas", () => {
  for (const name of FIXTURES) {
    it(`every operation in ${name}.wsdl`, async () => {
      const parsed = await parseWsdl(readFileSync(`fixtures/${name}.wsdl`, "utf8"));
      if (!parsed.ok) throw new Error(parsed.error.message);
      const schemas = generateSchemas(parsed.definition);
      expect(schemas.size).toBeGreaterThan(0);
      for (const [key, op] of schemas) {
        const result = buildZodSchema(op.outputDescriptor).safeParse(ghostResponse(op));
        expect(result.success, `${name}/${key}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
      }
    });
  }
});

describe("ghostResponse covers every scalar type xsdTypeToZod accepts", () => {
  const scalarTypes = [
    ...STRING_TYPES,
    ...INTEGER_TYPES,
    ...NUMBER_TYPES,
    "boolean",
    "date",
    "dateTime",
  ];

  it("produces a value that validates for each type", () => {
    expect(scalarTypes.length).toBeGreaterThan(0);
    for (const t of scalarTypes) {
      expect(xsdTypeToZod(t).warning, t).toBeUndefined();
      const descriptors = [field({ name: "v", xsdType: t })];
      const result = buildZodSchema(descriptors).safeParse(ghostResponse(makeOp(descriptors)));
      expect(result.success, `${t}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });
});

describe("ghostResponse determinism", () => {
  it("returns deeply equal results for repeated calls", () => {
    const op = makeOp([
      field({ name: "a" }),
      field({ name: "b", xsdType: "int", maxOccurs: "unbounded" }),
      field({ name: "c", xsdType: "c", children: [field({ name: "d", xsdType: "boolean" })] }),
    ]);
    const first = ghostResponse(op);
    expect(ghostResponse(op)).toEqual(first);
    expect(first).toEqual({ a: "ghost-a", b: [1], c: { d: true } });
  });
});

describe("ghostResponse per-type mapping", () => {
  it("maps each type to its ghost value", () => {
    const op = makeOp([
      field({ name: "title" }),
      field({ name: "count", xsdType: "int" }),
      field({ name: "big", xsdType: "xs:long" }),
      field({ name: "amount", xsdType: "decimal" }),
      field({ name: "day", xsdType: "date" }),
      field({ name: "flag", xsdType: "boolean" }),
      field({ name: "when", xsdType: "dateTime" }),
    ]);
    expect(ghostResponse(op)).toEqual({
      title: "ghost-title",
      count: 1,
      big: 1,
      amount: 0,
      day: "2000-01-01",
      flag: true,
      when: "2000-01-01T00:00:00.000Z",
    });
  });

  it("emits exactly one element for arrays (scalar and complex)", () => {
    const op = makeOp([
      field({ name: "tags", maxOccurs: "unbounded" }),
      field({ name: "rows", maxOccurs: 5, xsdType: "Row", children: [field({ name: "n", xsdType: "int" })] }),
    ]);
    expect(ghostResponse(op)).toEqual({ tags: ["ghost-tags"], rows: [{ n: 1 }] });
  });

  it("omits optional fields and emits null for nillable fields", () => {
    const op = makeOp([
      field({ name: "opt", minOccurs: 0 }),
      field({ name: "nil", nillable: true }),
      field({ name: "req" }),
    ]);
    const out = ghostResponse(op) as Record<string, unknown>;
    expect("opt" in out).toBe(false);
    expect(out).toEqual({ nil: null, req: "ghost-req" });
  });
});

describe("ghostResponse robustness", () => {
  it("terminates on a self-referential descriptor", () => {
    const node = field({ name: "node", xsdType: "Node", children: [] });
    node.children = [field({ name: "leaf", xsdType: "int" }), node];
    const out = ghostResponse(makeOp([node]));
    expect(out).toEqual({ node: { leaf: 1, node: {} } });
  });

  it("terminates on a very deeply nested descriptor", () => {
    let inner: FieldDescriptor = field({ name: "leaf", xsdType: "int" });
    for (let i = 0; i < 50; i++) {
      inner = field({ name: `n${i}`, xsdType: "T", children: [inner] });
    }
    const out = ghostResponse(makeOp([inner]));
    expect(typeof out).toBe("object");
    expect(out).not.toBeNull();
    expect(Object.keys(out as object)).toEqual(["n49"]);
  });

  it("does not throw on malformed descriptors", () => {
    const bad = [
      makeOp(undefined as unknown as FieldDescriptor[]),
      makeOp("nope" as unknown as FieldDescriptor[]),
      makeOp([null, 5, {}, { name: 3 }, { name: "ok", children: "x" }] as unknown as FieldDescriptor[]),
      undefined as unknown as OperationSchema,
      null as unknown as OperationSchema,
    ];
    for (const op of bad) {
      expect(() => ghostResponse(op)).not.toThrow();
    }
    expect(ghostResponse(makeOp(undefined as unknown as FieldDescriptor[]))).toEqual({});
    expect(
      ghostResponse(makeOp([null, 5, { name: "ok", xsdType: "string" }] as unknown as FieldDescriptor[])),
    ).toEqual({ ok: "ghost-ok" });
  });
});
