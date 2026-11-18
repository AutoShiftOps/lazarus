import fc from "fast-check";
import { describe, it } from "vitest";
import { buildTools } from "../../lib/mcp/tools";
import type { OperationSchema, ServiceDefinition } from "../../lib/soap/types";

function opNamed(name: string): OperationSchema {
  return {
    name,
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: `urn:${name}`,
    targetNamespace: "urn:test",
    inputElementName: name,
    outputElementName: `${name}Response`,
    endpointAddress: "https://example.test/svc",
    elementFormDefault: "qualified",
    inputDescriptor: [
      { name: "x", xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false },
    ],
    outputDescriptor: [],
    warnings: [],
    risk: "read",
    riskReason: "Reads data",
    riskSource: "heuristic",
  };
}

const nameArb = fc.oneof(
  fc.string(),
  fc.string({ unit: "grapheme" }),
  fc.constant(""),
  fc.string({ minLength: 65, maxLength: 200 }),
  fc.constantFrom("op", "op_2", "a b", "a_b", "y".repeat(64), "y".repeat(63) + "_"),
);

describe("Property 23: tool names are valid and unique", () => {
  it("**Validates: Requirements 2.1** names match the pattern and are distinct", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(nameArb, { maxLength: 15 }), { minLength: 1, maxLength: 3 }),
        (portNames) => {
          const service: ServiceDefinition = {
            name: "Svc",
            wsdlUrl: "https://example.test/svc?wsdl",
            warnings: [],
            ports: portNames.map((names, i) => ({
              name: `P${i}`,
              address: "https://example.test/svc",
              operations: names.map(opNamed),
            })),
          };
          const total = portNames.reduce((n, a) => n + a.length, 0);
          const tools = buildTools(service);
          const seen = new Set(tools.map((t) => t.name));
          return (
            tools.length === total &&
            seen.size === tools.length &&
            tools.every((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t.name))
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
