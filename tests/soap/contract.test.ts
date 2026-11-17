import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseWsdl } from "../../lib/soap/parser";
import { buildZodSchema, generateSchemas, xsdTypeToZod } from "../../lib/soap/schema-generator";
import { fromEnvelope, toEnvelope } from "../../lib/soap/translator";
import type { FieldDescriptor, OperationSchema, ServiceDefinition } from "../../lib/soap/types";

// Any network access fails the suite.
const httpSpy = vi.spyOn(http, "request").mockImplementation(() => {
  throw new Error("real network access attempted");
});
const httpsSpy = vi.spyOn(https, "request").mockImplementation(() => {
  throw new Error("real network access attempted");
});

const fetchCalls: string[] = [];
const fakeFetch = (url: string) => {
  fetchCalls.push(url);
  throw new Error(`network fetch attempted: ${url}`);
};

afterAll(() => {
  expect(fetchCalls).toEqual([]);
  expect(httpSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
});

type Fixture = {
  file: string;
  xml: string;
  declaresSoap12: boolean;
  def: ServiceDefinition;
  ops: OperationSchema[];
};

async function load(file: string): Promise<Fixture> {
  const xml = readFileSync(file, "utf8");
  const r = await parseWsdl(xml, { fetch: fakeFetch });
  if (!r.ok) throw new Error(`${file}: ${r.error.message}`);
  return {
    file,
    xml,
    declaresSoap12: xml.includes("http://schemas.xmlsoap.org/wsdl/soap12/"),
    def: r.definition,
    ops: r.definition.ports.flatMap((p) => p.operations),
  };
}

function leafFields(fields: FieldDescriptor[], out: FieldDescriptor[] = []): FieldDescriptor[] {
  for (const f of fields) {
    if (f.children) leafFields(f.children, out);
    else out.push(f);
  }
  return out;
}

function sampleLeaf(type: string): unknown {
  if (type === "boolean") return true;
  if (type === "date") return "2026-01-02";
  if (type === "dateTime") return "2026-01-02T03:04:05Z";
  if (type === "decimal" || type === "float" || type === "double") return 1.5;
  const probe = xsdTypeToZod(type).schema;
  if (probe.safeParse(7).success) return 7;
  return "abc";
}

function sampleArgs(fields: FieldDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const one: unknown = f.children ? sampleArgs(f.children) : sampleLeaf(f.xsdType);
    out[f.name] = f.maxOccurs === "unbounded" || f.maxOccurs > 1 ? [one] : one;
  }
  return out;
}

const fixtures: Fixture[] = [];
beforeAll(async () => {
  fixtures.push(await load("fixtures/calculator.wsdl"), await load("fixtures/countryinfo.wsdl"));
});

function fx(name: string): Fixture {
  const f = fixtures.find((x) => x.file.endsWith(name));
  if (!f) throw new Error("fixture not loaded");
  return f;
}

describe.each(["calculator.wsdl", "countryinfo.wsdl"])("contract: %s", (name) => {
  it("parses ok", () => {
    expect(fx(name).ops.length).toBeGreaterThan(0);
  });

  it("every operation has versions, endpoint and element names", () => {
    const f = fx(name);
    for (const op of f.ops) {
      expect(op.soapVersions).toContain("1.1");
      if (f.declaresSoap12) expect(op.soapVersions).toContain("1.2");
      expect(op.preferredVersion).toBe("1.1");
      expect(op.endpointAddress.length).toBeGreaterThan(0);
      expect(op.endpointAddress.startsWith("http")).toBe(true);
      expect(op.inputElementName.length).toBeGreaterThan(0);
    }
  });

  it("maps every field type and emits no XSD_TYPE_UNMAPPED warning", () => {
    const f = fx(name);
    const schemas = generateSchemas(f.def);
    expect(schemas.size).toBe(f.ops.length);
    const bad: string[] = [];
    for (const [key, op] of schemas) {
      for (const desc of [op.inputDescriptor, op.outputDescriptor]) {
        buildZodSchema(desc);
        for (const leaf of leafFields(desc)) {
          const { schema, warning } = xsdTypeToZod(leaf.xsdType);
          if (leaf.xsdType === "unknown" || warning !== undefined || schema instanceof z.ZodUnknown) {
            bad.push(`${key}.${leaf.name}: ${leaf.xsdType}`);
          }
        }
      }
      expect(op.warnings.filter((w) => w.code === "XSD_TYPE_UNMAPPED")).toEqual([]);
    }
    expect(bad, `unmapped types: ${bad.join(", ")}`).toEqual([]);
  });

  it("round-trips real descriptors through toEnvelope and fromEnvelope", () => {
    const f = fx(name);
    for (const [key, op] of generateSchemas(f.def)) {
      const args = sampleArgs(op.inputDescriptor);
      const env = toEnvelope(args, op);
      if (!env.ok) throw new Error(`${key}: toEnvelope failed: ${JSON.stringify(env.error)}`);
      expect(XMLValidator.validate(env.xml), `${key} envelope`).toBe(true);
      const back = fromEnvelope(env.xml, { ...op, outputDescriptor: op.inputDescriptor });
      if (!back.ok) throw new Error(`${key}: fromEnvelope failed: ${JSON.stringify(back.error)}`);
      expect(back.warnings, key).toEqual([]);
      expect(back.data, key).toEqual(args);
    }
  });

  it("reports no UNSUPPORTED_BINDING for SOAP bindings", () => {
    const f = fx(name);
    const all = [...f.def.warnings, ...f.ops.flatMap((o) => o.warnings)];
    const list = all.map((w) => `${w.code}: ${w.message}`).join("; ");
    expect(
      all.filter((w) => w.code === "UNSUPPORTED_BINDING"),
      `warnings: ${list}`,
    ).toEqual([]);
    if (name === "calculator.wsdl") expect(all, `warnings: ${list}`).toEqual([]);
  });
});

describe("contract: operation sets", () => {
  it("calculator has exactly Add, Subtract, Multiply, Divide", () => {
    expect(fx("calculator.wsdl").ops.map((o) => o.name).sort()).toEqual([
      "Add",
      "Divide",
      "Multiply",
      "Subtract",
    ]);
  });

  it("countryinfo has the expected operations", () => {
    const names = fx("countryinfo.wsdl").ops.map((o) => o.name);
    console.log(`CountryInfo operation count: ${names.length}`);
    for (const n of ["CountryFlag", "CountryName", "CapitalCity", "CountryCurrency"]) {
      expect(names).toContain(n);
    }
    expect(names.length).toBeGreaterThanOrEqual(4);
  });
});
