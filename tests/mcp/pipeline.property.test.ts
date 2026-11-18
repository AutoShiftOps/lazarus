import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipeline, type McpToolResult } from "../../lib/mcp/pipeline";
import { buildTools, type ToolDef } from "../../lib/mcp/tools";
import { createRegistry } from "../../lib/registry";
import { createApprovals } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { Rule } from "../../lib/safety/types";
import type { safePost } from "../../lib/soap/fetcher";
import type {
  BindingStyle,
  FieldDescriptor,
  OperationSchema,
  Risk,
  ServiceDefinition,
} from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const SERVICE_ID = "Abcd1234";
const NOW_MS = Date.parse("2026-01-01T12:00:00Z");
const GHOST_PREFIX = "[GHOST — nothing was sent to the real service]";
const OP_NAME = "TestOp";

type PostFn = typeof safePost;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Generators ───────────────────────────────────────────────────────────────

const LEAF_TYPES = ["string", "int", "decimal", "boolean", "date", "dateTime"] as const;

/** A field plus a generator for values that are valid for it. */
type FieldCase = { descriptor: FieldDescriptor; value: fc.Arbitrary<unknown> };

const OMIT: unique symbol = Symbol("omit");

const dateArb = fc
  .date({ min: new Date("1970-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z"), noInvalidDate: true });

function leafValue(xsdType: (typeof LEAF_TYPES)[number]): fc.Arbitrary<unknown> {
  switch (xsdType) {
    case "string":
      return fc.string();
    case "int":
      return fc.integer();
    case "decimal":
      return fc.double({ noNaN: true, noDefaultInfinity: true });
    case "boolean":
      return fc.boolean();
    case "date":
      return dateArb.map((d) => d.toISOString().slice(0, 10));
    case "dateTime":
      return dateArb.map((d) => d.toISOString());
  }
}

function objectFrom(names: string[], values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  names.forEach((n, i) => {
    if (values[i] !== OMIT) out[n] = values[i];
  });
  return out;
}

/** Builds an object arbitrary from field cases, in order. */
function objectArb(cases: FieldCase[]): fc.Arbitrary<Record<string, unknown>> {
  const names = cases.map((c) => c.descriptor.name);
  return fc.tuple(...cases.map((c) => c.value)).map((vals) => objectFrom(names, vals));
}

function fieldCaseArb(name: string, depth: number): fc.Arbitrary<FieldCase> {
  const kind: fc.Arbitrary<"leaf" | "complex"> =
    depth > 0 ? fc.constantFrom("leaf", "leaf", "complex") : fc.constant("leaf");
  return fc
    .record({
      kind,
      xsdType: fc.constantFrom(...LEAF_TYPES),
      minOccurs: fc.constantFrom(0, 1),
      maxOccurs: fc.constantFrom<number | "unbounded">(1, "unbounded"),
      nillable: fc.boolean(),
      omit: fc.boolean(),
      isNull: fc.boolean(),
      arrayLen: fc.integer({ min: 0, max: 3 }),
    })
    .chain((p) => {
      const childrenArb: fc.Arbitrary<FieldCase[]> =
        p.kind === "complex" ? casesArb(depth - 1) : fc.constant([]);
      return childrenArb.chain((children) => {
        const single: fc.Arbitrary<unknown> =
          p.kind === "complex" ? objectArb(children) : leafValue(p.xsdType);
        const isArray = p.maxOccurs === "unbounded";
        const base: fc.Arbitrary<unknown> = isArray
          ? fc.array(single, { minLength: 0, maxLength: p.arrayLen })
          : single;
        const value: fc.Arbitrary<unknown> = base.map((v): unknown => {
          if (p.minOccurs === 0 && p.omit) return OMIT;
          if (p.nillable && p.isNull) return null;
          return v;
        });
        const descriptor: FieldDescriptor = {
          name,
          xsdType: p.kind === "complex" ? "ComplexType" : p.xsdType,
          minOccurs: p.minOccurs,
          maxOccurs: p.maxOccurs,
          nillable: p.nillable,
          ...(p.kind === "complex" ? { children: children.map((c) => c.descriptor) } : {}),
        };
        return fc.constant<FieldCase>({ descriptor, value });
      });
    });
}

/** 0-4 fields with distinct, XML-safe names. */
function casesArb(depth: number): fc.Arbitrary<FieldCase[]> {
  return fc
    .uniqueArray(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,8}$/), { minLength: 0, maxLength: 4 })
    .chain((names) => fc.tuple(...names.map((n) => fieldCaseArb(`f${n}`, depth))));
}

function outputDescriptorArb(depth: number): fc.Arbitrary<FieldDescriptor[]> {
  return casesArb(depth).map((cs) => cs.map((c) => c.descriptor));
}

type OpCase = { op: OperationSchema; args: Record<string, unknown> };

function opCaseArb(risks: readonly Risk[]): fc.Arbitrary<OpCase> {
  return fc
    .record({
      cases: casesArb(2),
      output: outputDescriptorArb(2),
      risk: fc.constantFrom(...risks),
      bindingStyle: fc.constantFrom<BindingStyle>("document/literal", "rpc/literal"),
      version: fc.constantFrom<"1.1" | "1.2">("1.1", "1.2"),
      host: fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
      qualified: fc.boolean(),
    })
    .chain((p) =>
      objectArb(p.cases).map((args): OpCase => {
        const op: OperationSchema = {
          name: OP_NAME,
          soapVersions: [p.version],
          preferredVersion: p.version,
          bindingStyle: p.bindingStyle,
          soapAction: `urn:${OP_NAME}`,
          targetNamespace: "urn:test",
          inputElementName: OP_NAME,
          outputElementName: `${OP_NAME}Response`,
          endpointAddress: `https://${p.host}.example.test/svc`,
          elementFormDefault: p.qualified ? "qualified" : "unqualified",
          inputDescriptor: p.cases.map((c) => c.descriptor),
          outputDescriptor: p.output,
          warnings: [],
          risk: p.risk,
          riskReason: "Generated",
          riskSource: "heuristic",
        };
        return { op, args };
      }),
    );
}

const ruleArb = (i: number): fc.Arbitrary<Rule> =>
  fc.record({
    id: fc.constant(`rule-${i}`),
    operation: fc.constantFrom(OP_NAME, "*", "OtherOp"),
    effect: fc.constantFrom<"allow" | "hold">("allow", "hold"),
    reason: fc.string({ maxLength: 50 }),
    when: fc.option(
      fc.record({
        field: fc.constantFrom("fa", "fb", "fa.fb", "missing"),
        op: fc.constantFrom<"gt" | "eq" | "neq" | "contains">("gt", "eq", "neq", "contains"),
        value: fc.oneof(fc.string({ maxLength: 10 }), fc.integer(), fc.boolean()),
      }),
      { nil: undefined },
    ),
  });

const rulesArb: fc.Arbitrary<Rule[]> = fc
  .integer({ min: 0, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => ruleArb(i))))
  .map((rs) => rs.map((r) => (r.when === undefined ? { id: r.id, operation: r.operation, effect: r.effect, reason: r.reason } : r)));

// ─── Harness ──────────────────────────────────────────────────────────────────

async function runOnce(
  op: OperationSchema,
  args: unknown,
  opts: { ghost: boolean; rules: Rule[]; post: PostFn },
): Promise<McpToolResult> {
  const service: ServiceDefinition = {
    id: SERVICE_ID,
    name: "Svc",
    wsdlUrl: "https://example.test/svc?wsdl",
    warnings: [],
    ports: [{ name: "P", address: op.endpointAddress, operations: [op] }],
  };
  const tool: ToolDef | undefined = buildTools(service)[0];
  if (!tool) throw new Error("no tool built");

  const registry = createRegistry(createFakeRegistryRedis());
  expect((await registry.putSettings(SERVICE_ID, { ghost: opts.ghost })).ok).toBe(true);
  expect((await registry.putRules(SERVICE_ID, opts.rules)).ok).toBe(true);

  let clock = NOW_MS;
  let n = 0;
  const pipeline = createPipeline({
    registry,
    transcripts: createTranscripts(createFakeTranscriptRedis()),
    approvals: createApprovals(createFakeApprovalsRedis()),
    post: opts.post,
    rateRedis: createFakeRateRedis(() => clock),
    now: () => clock++,
    newId: () => `id-${++n}`,
  });
  return pipeline.runCall({ service, tool, args, clientIp: "203.0.113.9" });
}

function spyPost(): { post: PostFn; count: () => number } {
  let calls = 0;
  const post: PostFn = async () => {
    calls++;
    const body =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      `<${OP_NAME}Response xmlns="urn:test"/></soap:Body></soap:Envelope>`;
    return { ok: true, status: 200, body };
  };
  return { post, count: () => calls };
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe("Property 20: ghost never calls upstream", () => {
  it("**Validates: Requirements 8.1** valid args on a write/destructive op are simulated, never sent", async () => {
    await fc.assert(
      fc.asyncProperty(opCaseArb(["write", "destructive"]), rulesArb, async ({ op, args }, rules) => {
        const spy = spyPost();
        const res = await runOnce(op, args, { ghost: true, rules, post: spy.post });
        expect(spy.count()).toBe(0);
        expect(res.isError).toBeUndefined();
        expect(res.structuredContent?.ghost).toBe(true);
        expect(res.content[0].text.startsWith(GHOST_PREFIX)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("**Validates: Requirements 8.1** arbitrary (mostly invalid) args never reach the upstream", async () => {
    await fc.assert(
      fc.asyncProperty(
        opCaseArb(["write", "destructive"]),
        fc.anything(),
        rulesArb,
        async ({ op }, junk, rules) => {
          const spy = spyPost();
          await runOnce(op, junk, { ghost: true, rules, post: spy.post });
          expect(spy.count()).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("generator is not vacuous", () => {
  it("the same ops with ghost off and risk write do call the upstream once", async () => {
    await fc.assert(
      fc.asyncProperty(opCaseArb(["write"]), async ({ op, args }) => {
        const spy = spyPost();
        const res = await runOnce(op, args, { ghost: false, rules: [], post: spy.post });
        expect(spy.count()).toBe(1);
        expect(res.structuredContent?.ghost).not.toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});
