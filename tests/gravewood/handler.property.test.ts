import { XMLParser, XMLValidator } from "fast-xml-parser";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import type { BankState, HandlerResult } from "../../lib/gravewood/types";

const NOW = "2024-01-01T00:00:00.000Z";
const SEED_TOTAL_CENTS = 6365000;
const REAL_IDS = ["4471", "5530", "9902", "7718"] as const;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Builds a real SOAP 1.1 envelope. Field values are XML-escaped. */
function buildRequest(op: string, fields: Record<string, string>, prefix = ""): string {
  const p = prefix === "" ? "" : `${prefix}:`;
  const xmlns = prefix === "" ? ` xmlns="urn:gravewood"` : ` xmlns:${prefix}="urn:gravewood"`;
  const inner = Object.entries(fields)
    .map(([k, v]) => `<${p}${k}>${escapeXml(v)}</${p}${k}>`)
    .join("");
  return (
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${p}${op}${xmlns}>${inner}</${p}${op}></soap:Body></soap:Envelope>`
  );
}

/** Calls handleSoap with the matching SOAPAction; the caller applies state only when ok. */
function run(state: BankState, req: string, op: string): HandlerResult {
  return handleSoap(state, `"urn:gravewood:${op}"`, req, NOW);
}

// ---------- generators ----------

type Step = { op: string; fields: Record<string, string>; prefix: string };

const accountIdArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...REAL_IDS) },
  { weight: 2, arbitrary: fc.stringMatching(/^[0-9]{1,12}$/) },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);

const amountArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 2_000_000 }).map((c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 100000 }).map(String) },
  { weight: 1, arbitrary: fc.constantFrom("99999999999999999999.99", "1e308", "9007199254740993", "999999999999999999999999999") },
  { weight: 1, arbitrary: fc.constantFrom("0", "0.00", "-0.01", "-5", "-1000000") },
  { weight: 1, arbitrary: fc.constantFrom("", " ", "abc", "1.234", "1,00", "NaN", "Infinity", "0x10", "1e2", "--1") },
  { weight: 1, arbitrary: fc.string({ maxLength: 10 }) },
);

const prefixArb = fc.constantFrom("", "", "gw", "t");

const transferArb: fc.Arbitrary<Step> = fc.record({
  op: fc.constant("TransferFunds"),
  fields: fc.record({ fromAccount: accountIdArb, toAccount: accountIdArb, amount: amountArb }),
  prefix: prefixArb,
});

const closeArb: fc.Arbitrary<Step> = fc.record({
  op: fc.constant("CloseAccount"),
  fields: fc.record({ accountId: accountIdArb }),
  prefix: prefixArb,
});

const updateArb: fc.Arbitrary<Step> = fc.record({
  op: fc.constant("UpdateAddress"),
  fields: fc.record({ accountId: accountIdArb, address: fc.string({ maxLength: 40 }) }),
  prefix: prefixArb,
});

const readArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ op: fc.constant("ListAccounts"), fields: fc.constant({} as Record<string, string>), prefix: prefixArb }),
  fc.record({ op: fc.constant("GetBalance"), fields: fc.record({ accountId: accountIdArb }), prefix: prefixArb }),
  fc.record({ op: fc.constant("GetStatement"), fields: fc.record({ accountId: accountIdArb }), prefix: prefixArb }),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: transferArb },
  { weight: 1, arbitrary: closeArb },
  { weight: 1, arbitrary: updateArb },
  { weight: 2, arbitrary: readArb },
);

function runStep(state: BankState, s: Step): HandlerResult {
  return run(state, buildRequest(s.op, s.fields, s.prefix), s.op);
}

function assertInvariants(state: BankState): void {
  const total = state.accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  expect(total).toBe(SEED_TOTAL_CENTS);
  for (const a of state.accounts) {
    expect(Number.isInteger(a.balanceCents)).toBe(true);
    expect(a.balanceCents).toBeGreaterThanOrEqual(0);
    const txnSum = state.txns
      .filter((t) => t.accountId === a.id)
      .reduce((sum, t) => sum + t.amountCents, 0);
    expect(txnSum).toBe(a.balanceCents);
  }
}

describe("Gravewood handler properties", () => {
  // Feature: gravewood-bank, Property 11: Transfers conserve money
  // **Validates: Requirements 5.5**
  it("Property 11: transfers conserve money and keep ledgers consistent", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 30 }), (steps) => {
        let state = seedState();
        assertInvariants(state);
        for (const s of steps) {
          const res = runStep(state, s);
          if (res.ok) state = res.state;
          assertInvariants(state);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: gravewood-bank, Property 12: Failed operations change nothing
  // **Validates: Requirements 5.6**
  it("Property 12: a faulting request returns the same state reference, unchanged", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 20 }), (steps) => {
        let state = seedState();
        for (const s of steps) {
          const before = JSON.stringify(state);
          const res = runStep(state, s);
          if (res.ok) {
            state = res.state;
          } else {
            expect(res.state).toBe(state);
            expect(JSON.stringify(res.state)).toBe(before);
            expect(JSON.stringify(state)).toBe(before);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: gravewood-bank, Property 15: Faults leak nothing
  // **Validates: Requirements 5.7**
  describe("Property 15: faults leak nothing", () => {
    const FRAGMENTS = ["gw:", "node_modules", "/home/x", "    at Foo (x.ts:1:1)", "<!DOCTYPE"] as const;
    const FORBIDDEN = ["    at ", "node_modules", "/home", "gw:", ".ts:", ".js:"] as const;
    const STACK_LIKE = /\bat\s/;
    const fragmentArb = fc.constantFrom(...FRAGMENTS);

    const validStepArb = fc.oneof(transferArb, closeArb, updateArb, readArb);
    const validRequestArb = validStepArb.map((s) => ({
      req: buildRequest(s.op, s.fields, s.prefix),
      op: s.op,
    }));

    const injectedArb = fc
      .tuple(validRequestArb, fragmentArb, fc.nat())
      .map(([v, frag, pos]) => {
        const i = pos % (v.req.length + 1);
        return v.req.slice(0, i) + frag + v.req.slice(i);
      });

    const truncatedArb = fc
      .tuple(validRequestArb, fc.nat())
      .map(([v, n]) => v.req.slice(0, n % v.req.length));

    const fragmentIdArb = fc
      .tuple(fragmentArb, fragmentArb)
      .map(([a, b]) => buildRequest("GetBalance", { accountId: a + b }, "gw"));
    const fragmentTransferArb = fragmentArb.map((f) =>
      buildRequest("TransferFunds", { fromAccount: f, toAccount: f, amount: f }, "gw"),
    );
    const fragmentOpArb = fragmentArb.map((f) =>
      buildRequest(f.replace(/[^A-Za-z0-9]/g, "X") || "X", {}, ""),
    );

    const bodyArb = fc.oneof(
      fc.string({ unit: "binary" }),
      fc.string(),
      truncatedArb,
      injectedArb,
      fragmentIdArb,
      fragmentTransferArb,
      fragmentOpArb,
      fragmentArb,
    );

    const actionArb = fc.oneof(
      fc.constant<string | null>(null),
      fc.string({ unit: "binary" }),
      fragmentArb,
      fc.constantFrom(
        '"urn:gravewood:ListAccounts"',
        "urn:gravewood:GetBalance",
        "urn:gravewood:Nope",
        '""',
        "",
      ),
    );

    it("responses are well-formed, carry a faultcode, and leak no internals", () => {
      const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
      fc.assert(
        fc.property(bodyArb, actionArb, (body, action) => {
          const state = seedState();
          const res = handleSoap(state, action, body, NOW);
          expect(XMLValidator.validate(res.xml)).toBe(true);
          if (res.ok) {
            expect(res.status).toBe(200);
            return;
          }
          expect(res.status).not.toBe(200);
          expect(res.xml).toContain("<faultcode>");
          const doc = parser.parse(res.xml) as {
            Envelope: { Body: { Fault: { faultstring: string } } };
          };
          const faultstring = String(doc.Envelope.Body.Fault.faultstring);
          for (const bad of FORBIDDEN) expect(faultstring).not.toContain(bad);
          for (const frag of FRAGMENTS) expect(faultstring).not.toContain(frag);
          expect(STACK_LIKE.test(faultstring)).toBe(false);
        }),
        { numRuns: 300 },
      );
    });
  });
});
