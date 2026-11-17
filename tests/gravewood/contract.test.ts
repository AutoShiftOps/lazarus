import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import { parseWsdl } from "../../lib/soap/parser";
import { generateSchemas } from "../../lib/soap/schema-generator";
import { fromEnvelope, toEnvelope } from "../../lib/soap/translator";
import type { OperationSchema, ServiceDefinition } from "../../lib/soap/types";

const NOW = "2026-01-01T12:00:00Z";

const throwingFetch = (url: string): never => {
  throw new Error(`network fetch attempted: ${url}`);
};

let def: ServiceDefinition;
const ops = new Map<string, OperationSchema>();

beforeAll(async () => {
  const xml = readFileSync("fixtures/gravewood.wsdl", "utf8");
  const r = await parseWsdl(xml, { fetch: throwingFetch });
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  def = r.definition;
  for (const op of generateSchemas(def).values()) ops.set(op.name, op);
});

function op(name: string): OperationSchema {
  const o = ops.get(name);
  if (!o) throw new Error(`operation ${name} missing`);
  return o;
}

/** Full pipeline: translator -> handler on a fresh seed -> translator. */
function call(name: string, args: Record<string, unknown>) {
  const schema = op(name);
  const env = toEnvelope(args, schema);
  if (!env.ok) throw new Error(`${name}: toEnvelope failed: ${JSON.stringify(env.error)}`);
  const res = handleSoap(seedState(), env.headers.SOAPAction ?? null, env.xml, NOW);
  return { res, parsed: fromEnvelope(res.xml, schema) };
}

function data(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const { res, parsed } = call(name, args);
  if (!parsed.ok) throw new Error(`${name}: ${JSON.stringify(parsed.error)}`);
  expect(res.ok).toBe(true);
  expect(parsed.warnings).toEqual([]);
  return parsed.data;
}

describe("gravewood contract: WSDL through the real Lazarus pipeline", () => {
  it("parses with zero warnings and exposes six operations", () => {
    expect(def.warnings).toEqual([]);
    expect([...ops.values()].flatMap((o) => o.warnings)).toEqual([]);
    expect([...ops.keys()].sort()).toEqual([
      "CloseAccount",
      "GetBalance",
      "GetStatement",
      "ListAccounts",
      "TransferFunds",
      "UpdateAddress",
    ]);
  });

  it("GetBalance", () => {
    expect(data("GetBalance", { accountId: "4471" })).toEqual({
      accountId: "4471",
      balance: 12450,
      asOf: NOW,
    });
  });

  it("ListAccounts returns 4 accounts in seed order", () => {
    const out = data("ListAccounts", {});
    const accounts = out.account as Array<Record<string, unknown>>;
    expect(accounts.map((a) => a.id)).toEqual(["4471", "5530", "9902", "7718"]);
    expect(accounts[0]).toMatchObject({ balance: 12450, status: "OPEN", openedOn: "2019-04-02" });
  });

  describe("GetStatement", () => {
    it("without optional dates: 6 transactions oldest first, null and string memos", () => {
      const out = data("GetStatement", { accountId: "4471" });
      expect(out.accountId).toBe("4471");
      const txns = out.transaction as Array<Record<string, unknown>>;
      expect(txns).toHaveLength(6);
      const stamps = txns.map((t) => t.timestamp as string);
      expect([...stamps].sort()).toEqual(stamps);
      expect(txns[0]).toMatchObject({ id: "t-4471-01", amount: 10000, memo: null });
      expect(txns[0]).toHaveProperty("memo", null);
      expect(txns[1]).toMatchObject({ id: "t-4471-02", amount: 4500, memo: "Invoice 2041" });
    });

    it("with both optional dates present", () => {
      const out = data("GetStatement", {
        accountId: "4471",
        fromDate: "2019-01-01",
        toDate: "2026-01-01",
      });
      expect((out.transaction as unknown[]).length).toBe(6);
    });

    it("with dates after every transaction returns no transactions", () => {
      const out = data("GetStatement", { accountId: "4471", fromDate: "2026-01-01", toDate: "2026-01-01" });
      expect(out.accountId).toBe("4471");
      expect(out.transaction ?? []).toEqual([]);
    });
  });

  it("TransferFunds", () => {
    const out = data("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 25.5 });
    expect(out.fromBalance).toBe(12424.5);
    expect(out.toBalance).toBe(48025.5);
    expect(out.confirmationId).toMatch(/^GW-/);
  });

  it("UpdateAddress", () => {
    expect(data("UpdateAddress", { accountId: "4471", address: "1 Hollow Creek Rd" })).toEqual({
      updated: true,
    });
  });

  it("CloseAccount", () => {
    expect(data("CloseAccount", { accountId: "4471" })).toEqual({ closed: true, closedAt: NOW });
  });

  describe("fault path", () => {
    it("unknown account is a Client fault", () => {
      const { res, parsed } = call("GetBalance", { accountId: "9999" });
      expect(res.ok).toBe(false);
      expect(parsed.ok).toBe(false);
      if (parsed.ok || parsed.error.type !== "fault") throw new Error("expected fault");
      expect(parsed.error.faultCode).toContain("Client");
      expect(parsed.error.faultString).toBe("Account 9999 not found");
    });

    it("overdraft is Insufficient funds", () => {
      const { parsed } = call("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 99999999 });
      if (parsed.ok || parsed.error.type !== "fault") throw new Error("expected fault");
      expect(parsed.error.faultString).toBe("Insufficient funds");
    });
  });
});
