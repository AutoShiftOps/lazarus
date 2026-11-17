import { readFileSync } from "node:fs";
import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { buildWsdl } from "../../lib/gravewood/wsdl";
import { parseWsdl } from "../../lib/soap/parser";
import { heuristicRisk } from "../../lib/soap/risk";
import { generateSchemas } from "../../lib/soap/schema-generator";
import type { Risk, ServiceDefinition } from "../../lib/soap/types";

const PLACEHOLDER = "http://localhost:3000/api/gravewood/SANDBOXID";
const FIXTURE = readFileSync("fixtures/gravewood.wsdl", "utf8");
const OPS = [
  "ListAccounts",
  "GetBalance",
  "GetStatement",
  "TransferFunds",
  "UpdateAddress",
  "CloseAccount",
];

const throwingFetch = () => {
  throw new Error("network fetch attempted");
};

async function parseFixture(): Promise<ServiceDefinition> {
  const r = await parseWsdl(FIXTURE, { fetch: throwingFetch });
  if (!r.ok) throw new Error(r.error.message);
  return r.definition;
}

describe("buildWsdl", () => {
  it("equals the fixture for the placeholder endpoint", () => {
    expect(buildWsdl(PLACEHOLDER)).toBe(FIXTURE);
  });

  it("changes only the soap:address when the endpoint changes", () => {
    const other = "https://example.com/api/gravewood/abc123";
    const a = buildWsdl(PLACEHOLDER).replace(PLACEHOLDER, "@@");
    const b = buildWsdl(other).replace(other, "@@");
    expect(a).toBe(b);
    expect(buildWsdl(other)).toContain(`<soap:address location="${other}"/>`);
  });

  it("escapes & and \" in the endpoint and stays well-formed", () => {
    const xml = buildWsdl('http://h/x?a=1&b="2"<>');
    expect(xml).toContain('location="http://h/x?a=1&amp;b=&quot;2&quot;&lt;&gt;"');
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it("contains the required schema features and no imports", () => {
    expect(FIXTURE).not.toContain("xsd:import");
    expect(FIXTURE).not.toContain("xsd:include");
    for (const s of [
      'maxOccurs="unbounded"',
      'minOccurs="0"',
      'nillable="true"',
      "xsd:decimal",
      "xsd:dateTime",
    ]) {
      expect(FIXTURE).toContain(s);
    }
  });
});

describe("gravewood.wsdl through the Lazarus parser", () => {
  it("parses with no warnings and exactly the six operations", async () => {
    const def = await parseFixture();
    expect(def.warnings).toEqual([]);
    expect(def.ports).toHaveLength(1);
    const ops = def.ports[0].operations;
    expect(ops.map((o) => o.name).sort()).toEqual([...OPS].sort());
    for (const op of ops) {
      expect(op.warnings).toEqual([]);
      expect(op.soapVersions).toEqual(["1.1"]);
      expect(op.bindingStyle).toBe("document/literal");
      expect(op.endpointAddress).toBe(PLACEHOLDER);
      expect(op.soapAction).toBe(`urn:gravewood:${op.name}`);
    }
  });

  it("classifies risk heuristically from name and documentation", async () => {
    const def = await parseFixture();
    const expected: Record<string, Risk> = {
      ListAccounts: "read",
      GetBalance: "read",
      GetStatement: "read",
      TransferFunds: "write",
      UpdateAddress: "write",
      CloseAccount: "destructive",
    };
    for (const op of def.ports[0].operations) {
      expect(op.documentation, op.name).toBeTruthy();
      expect(heuristicRisk(op.name, op.documentation).risk, op.name).toBe(expected[op.name]);
    }
  });

  it("generates schemas without unmapped types and with the expected descriptors", async () => {
    const def = await parseFixture();
    const schemas = generateSchemas(def);
    expect(schemas.size).toBe(6);
    for (const s of schemas.values()) {
      expect(s.warnings.filter((w) => w.code === "XSD_TYPE_UNMAPPED")).toEqual([]);
    }

    const transfer = schemas.get("TransferFunds");
    expect(transfer?.inputDescriptor.map((f) => [f.name, f.xsdType])).toEqual([
      ["fromAccount", "string"],
      ["toAccount", "string"],
      ["amount", "decimal"],
    ]);

    const stmt = schemas.get("GetStatement");
    const dates = stmt?.inputDescriptor.filter((f) => f.name === "fromDate" || f.name === "toDate");
    expect(dates?.map((f) => f.name)).toEqual(["fromDate", "toDate"]);
    expect(dates?.every((f) => f.minOccurs === 0)).toBe(true);

    const txn = stmt?.outputDescriptor.find((f) => f.name === "transaction");
    expect(txn?.maxOccurs).toBe("unbounded");
    expect(txn?.children?.find((c) => c.name === "memo")?.nillable).toBe(true);
  });
});
