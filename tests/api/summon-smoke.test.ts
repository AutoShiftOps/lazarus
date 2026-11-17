import { describe, expect, it } from "vitest";
import { summon } from "../../lib/summon";
import type { OperationSchema, ServiceDefinition } from "../../lib/soap/types";

const op: OperationSchema = {
  name: "Add",
  soapVersions: ["1.1"],
  preferredVersion: "1.1",
  bindingStyle: "document/literal",
  soapAction: "http://x/Add",
  targetNamespace: "http://x/",
  inputElementName: "Add",
  outputElementName: "AddResponse",
  endpointAddress: "http://internal.example/svc",
  elementFormDefault: "qualified",
  risk: "write",
  riskReason: "test",
  riskSource: "heuristic",
  inputDescriptor: [],
  outputDescriptor: [],
  warnings: [],
};
const def: ServiceDefinition = {
  name: "Calc",
  wsdlUrl: "http://example.com/c?WSDL",
  ports: [{ name: "P", address: "http://internal.example/svc", operations: [op] }],
  warnings: [],
};

describe("summon smoke", () => {
  it("returns a 200 body without endpointAddress", async () => {
    const res = await summon("http://example.com/c?WSDL", "https://lazarus.test", {
      fetchWsdl: async () => ({ ok: true, xml: "<x/>", finalUrl: "http://example.com/c?WSDL" }),
      parseWsdl: async () => ({ ok: true, definition: def }),
      generateSchemas: (s) => new Map([["Add", structuredClone(s.ports[0].operations[0])]]),
      upsertService: async () => ({ ok: true, id: "abcd1234", created: true }),
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.mcpUrl).toBe("https://lazarus.test/api/mcp/abcd1234");
    expect(body.warnings).toEqual([]);
    expect(Array.isArray(body.operations)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("endpointAddress");
  });
});
