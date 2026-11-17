import { describe, expect, it } from "vitest";
import {
  getBalance,
  getStatement,
  listAccounts,
  transferFunds,
  type OpResult,
} from "../../lib/gravewood/handler";
import { formatSignedCents } from "../../lib/gravewood/money";
import { seedState } from "../../lib/gravewood/seed";
import type { BankState } from "../../lib/gravewood/types";
import type { XmlNode } from "../../lib/gravewood/xml";

const NOW = "2026-01-02T03:04:05Z";

/** Runs op against a seeded state and asserts the input was not mutated. */
function run(
  op: (s: BankState) => OpResult,
  state: BankState = seedState(),
): { res: OpResult; state: BankState } {
  const snapshot = structuredClone(state);
  const res = op(state);
  expect(state).toEqual(snapshot);
  if (res.ok) {
    expect(res.state).toBe(state);
    expect(res.state.version).toBe(snapshot.version);
  }
  return { res, state };
}

function fault(res: OpResult): string {
  if (res.ok) throw new Error("expected fault");
  expect(res.kind).toBe("Client");
  return res.message;
}

function node(res: OpResult): XmlNode {
  if (!res.ok) throw new Error(`unexpected fault: ${res.message}`);
  return res.node;
}

function field(n: XmlNode, name: string): XmlNode {
  const c = n.children?.find((x) => x.name === name);
  if (!c) throw new Error(`missing ${name}`);
  return c;
}

const statement = (params: Record<string, unknown>) =>
  run((s) => getStatement(s, params, NOW)).res;

describe("listAccounts", () => {
  it("returns every account in state order with formatted fields", () => {
    const { res, state } = run((s) => listAccounts(s));
    const n = node(res);
    expect(n.name).toBe("ListAccountsResponse");
    expect(n.children?.map((c) => c.name)).toEqual(state.accounts.map(() => "account"));
    const first = n.children![0];
    expect(first.children?.map((c) => c.name)).toEqual([
      "id",
      "name",
      "balance",
      "status",
      "openedOn",
    ]);
    expect(field(first, "id").text).toBe(state.accounts[0].id);
    expect(field(first, "balance").text).toBe("12450.00");
    expect(field(first, "status").text).toBe("OPEN");
    expect(n.children?.map((c) => field(c, "id").text)).toEqual(state.accounts.map((a) => a.id));
  });
});

describe("getBalance", () => {
  it("returns balance and asOf", () => {
    const n = node(run((s) => getBalance(s, { accountId: "4471" }, NOW)).res);
    expect(n).toEqual({
      name: "GetBalanceResponse",
      children: [
        { name: "accountId", text: "4471" },
        { name: "balance", text: "12450.00" },
        { name: "asOf", text: NOW },
      ],
    });
  });

  it("reads closed accounts", () => {
    const s = seedState();
    s.accounts[0].status = "CLOSED";
    const n = node(run((st) => getBalance(st, { accountId: "4471" }, NOW), s).res);
    expect(field(n, "balance").text).toBe("12450.00");
  });

  it("faults on unknown account", () => {
    expect(fault(run((s) => getBalance(s, { accountId: "999" }, NOW)).res)).toBe(
      "Account 999 not found",
    );
  });

  it.each(["abc", "", "1234567890123", "12 3", "<x>", "-1"])("rejects account id %j", (id) => {
    expect(fault(run((s) => getBalance(s, { accountId: id }, NOW)).res)).toBe(
      "Invalid account id",
    );
  });

  it("rejects missing accountId", () => {
    expect(fault(run((s) => getBalance(s, {}, NOW)).res)).toBe("Invalid request");
  });

  it.each([
    ["array", ["4471"]],
    ["object", { a: "1" }],
    ["number", 4471],
    ["null", null],
  ])("rejects %s accountId", (_n, v) => {
    expect(fault(run((s) => getBalance(s, { accountId: v }, NOW)).res)).toBe("Invalid request");
  });

  it("rejects any non-string extra param", () => {
    expect(fault(run((s) => getBalance(s, { accountId: "4471", x: ["a"] }, NOW)).res)).toBe(
      "Invalid request",
    );
  });
});

describe("getStatement", () => {
  const ids = (res: OpResult) =>
    node(res)
      .children!.filter((c) => c.name === "transaction")
      .map((t) => field(t, "id").text);

  it("returns all transactions oldest first with signed amounts and nil memo", () => {
    const res = statement({ accountId: "4471" });
    const n = node(res);
    expect(n.name).toBe("GetStatementResponse");
    expect(field(n, "accountId").text).toBe("4471");
    const txs = n.children!.filter((c) => c.name === "transaction");
    expect(txs).toHaveLength(6);
    expect(txs[0].children?.map((c) => c.name)).toEqual([
      "id",
      "timestamp",
      "description",
      "amount",
      "memo",
    ]);
    expect(field(txs[0], "memo")).toEqual({ name: "memo", nil: true });
    expect(field(txs[1], "memo")).toEqual({ name: "memo", text: "Invoice 2041" });
    expect(field(txs[2], "amount").text).toBe("-1200.00");
    expect(field(txs[0], "amount").text).toBe("10000.00");
    const stamps = txs.map((t) => field(t, "timestamp").text!);
    expect(stamps).toEqual([...stamps].sort());
  });

  it("sorts by ts then id regardless of stored order", () => {
    const s = seedState();
    s.txns = [
      { id: "b", accountId: "4471", ts: "2020-01-01T00:00:00Z", description: "", amountCents: 1, memo: null },
      { id: "c", accountId: "4471", ts: "2019-01-01T00:00:00Z", description: "", amountCents: 1, memo: null },
      { id: "a", accountId: "4471", ts: "2020-01-01T00:00:00Z", description: "", amountCents: 1, memo: null },
    ];
    expect(ids(run((st) => getStatement(st, { accountId: "4471" }, NOW), s).res)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("range is inclusive on the date part of ts", () => {
    const res = statement({ accountId: "4471", fromDate: "2019-09-17", toDate: "2020-08-21" });
    expect(ids(res)).toEqual(["t-4471-02", "t-4471-03", "t-4471-04"]);
  });

  it("supports a single-day range and open-ended ranges", () => {
    expect(ids(statement({ accountId: "4471", fromDate: "2019-04-02", toDate: "2019-04-02" }))).toEqual([
      "t-4471-01",
    ]);
    expect(ids(statement({ accountId: "4471", fromDate: "2021-01-12" }))).toEqual([
      "t-4471-05",
      "t-4471-06",
    ]);
    expect(ids(statement({ accountId: "4471", toDate: "2019-04-02" }))).toEqual(["t-4471-01"]);
  });

  it("returns an empty list for an empty range", () => {
    const n = node(statement({ accountId: "4471", fromDate: "2030-01-01", toDate: "2030-12-31" }));
    expect(n.children).toEqual([{ name: "accountId", text: "4471" }]);
  });

  it("does not include other accounts' transactions and reads closed accounts", () => {
    const s = seedState();
    s.accounts[1].status = "CLOSED";
    const res = run((st) => getStatement(st, { accountId: "5530" }, NOW), s).res;
    expect(ids(res).every((i) => i?.startsWith("t-5530-"))).toBe(true);
    expect(ids(res)).toHaveLength(6);
  });

  it("faults on unknown account", () => {
    expect(fault(statement({ accountId: "12345" }))).toBe("Account 12345 not found");
  });

  it.each(["2026-02-30", "tomorrow", "2026-2-3", "2026-13-01", "2025-02-29", "", "2026-01-01T00:00:00Z"])(
    "rejects fromDate %j",
    (d) => {
      expect(fault(statement({ accountId: "4471", fromDate: d }))).toBe("Invalid date");
    },
  );

  it("rejects an invalid toDate", () => {
    expect(fault(statement({ accountId: "4471", toDate: "2026-04-31" }))).toBe("Invalid date");
  });

  it("accepts a leap day", () => {
    expect(statement({ accountId: "4471", fromDate: "2024-02-29" }).ok).toBe(true);
  });

  it("faults when fromDate is after toDate", () => {
    expect(fault(statement({ accountId: "4471", fromDate: "2021-01-02", toDate: "2021-01-01" }))).toBe(
      "fromDate is after toDate",
    );
  });

  it("rejects bad account ids and missing/non-string params", () => {
    expect(fault(statement({ accountId: "x" }))).toBe("Invalid account id");
    expect(fault(statement({}))).toBe("Invalid request");
    expect(fault(statement({ accountId: ["4471"] }))).toBe("Invalid request");
    expect(fault(statement({ accountId: "4471", fromDate: ["2020-01-01"] }))).toBe("Invalid request");
    expect(fault(statement({ accountId: "4471", toDate: { a: "b" } }))).toBe("Invalid request");
  });

  it("does not echo hostile ids in faults", () => {
    const msg = fault(statement({ accountId: "<script>" }));
    expect(msg).not.toContain("<");
  });
});

describe("formatSignedCents", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [120000, "1200.00"],
    [-5, "-0.05"],
    [-120000, "-1200.00"],
    [-1, "-0.01"],
  ])("formats %d as %s", (c, s) => {
    expect(formatSignedCents(c)).toBe(s);
  });

  it.each([1.5, NaN, Infinity])("throws on non-integer %s", (c) => {
    expect(() => formatSignedCents(c)).toThrow(RangeError);
  });
});

describe("transferFunds", () => {
  const NOW_MS = "2026-01-02T03:04:05.678Z";

  /** Runs a transfer, asserting the input state is never mutated. */
  function transfer(
    params: Record<string, unknown>,
    state: BankState = seedState(),
    now = NOW,
  ): OpResult {
    const snapshot = structuredClone(state);
    const res = transferFunds(state, params, now);
    expect(state).toEqual(snapshot);
    if (res.ok) {
      expect(res.state).not.toBe(state);
    }
    return res;
  }

  const ok = (from: string, to: string, amount: string) => ({
    fromAccount: from,
    toAccount: to,
    amount,
  });

  function okState(res: OpResult): BankState {
    if (!res.ok) throw new Error(`unexpected fault: ${res.message}`);
    return res.state;
  }

  const total = (s: BankState) => s.accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const bal = (s: BankState, id: string) => s.accounts.find((a) => a.id === id)!.balanceCents;

  it("transfers funds and returns confirmation and formatted balances", () => {
    const res = transfer(ok("4471", "5530", "100.50"));
    expect(node(res)).toEqual({
      name: "TransferFundsResponse",
      children: [
        { name: "confirmationId", text: "GW-1001" },
        { name: "fromBalance", text: "12349.50" },
        { name: "toBalance", text: "48100.50" },
      ],
    });
    const s = okState(res);
    expect(s.version).toBe(1);
    expect(s.nextConfirmation).toBe(1002);
    expect(bal(s, "4471")).toBe(1234950);
    expect(bal(s, "5530")).toBe(4810050);
  });

  it("appends two transactions with the right sign, ids, description and truncated ts", () => {
    const s = okState(transfer(ok("4471", "5530", "10"), seedState(), NOW_MS));
    const base = seedState();
    expect(s.txns).toHaveLength(base.txns.length + 2);
    expect(s.txns.slice(-2)).toEqual([
      {
        id: "t-4471-07",
        accountId: "4471",
        ts: "2026-01-02T03:04:05Z",
        description: "Transfer to 5530",
        amountCents: -1000,
        memo: null,
      },
      {
        id: "t-5530-07",
        accountId: "5530",
        ts: "2026-01-02T03:04:05Z",
        description: "Transfer from 4471",
        amountCents: 1000,
        memo: null,
      },
    ]);
  });

  it("new transactions show up in getStatement of both accounts", () => {
    const s = okState(transfer(ok("4471", "5530", "25.00")));
    const from = node(getStatement(s, { accountId: "4471", fromDate: "2026-01-02" }, NOW));
    const to = node(getStatement(s, { accountId: "5530", fromDate: "2026-01-02" }, NOW));
    const fromTx = from.children!.filter((c) => c.name === "transaction");
    const toTx = to.children!.filter((c) => c.name === "transaction");
    expect(fromTx).toHaveLength(1);
    expect(toTx).toHaveLength(1);
    expect(field(fromTx[0], "amount").text).toBe("-25.00");
    expect(field(fromTx[0], "description").text).toBe("Transfer to 5530");
    expect(field(toTx[0], "amount").text).toBe("25.00");
    expect(field(toTx[0], "description").text).toBe("Transfer from 4471");
  });

  it("allows a transfer of the exact balance, leaving 0.00", () => {
    const res = transfer(ok("4471", "5530", "12450.00"));
    const n = node(res);
    expect(field(n, "fromBalance").text).toBe("0.00");
    expect(field(n, "toBalance").text).toBe("60450.00");
    expect(bal(okState(res), "4471")).toBe(0);
  });

  it("allows a 1 cent transfer", () => {
    const res = transfer(ok("4471", "5530", "0.01"));
    const n = node(res);
    expect(field(n, "fromBalance").text).toBe("12449.99");
    expect(field(n, "toBalance").text).toBe("48000.01");
    expect(okState(res).txns.slice(-2).map((t) => t.amountCents)).toEqual([-1, 1]);
  });

  it("increments confirmation ids and txn ids across chained transfers and conserves money", () => {
    const start = seedState();
    const t0 = total(start);
    let s = start;
    const ids: string[] = [];
    for (const [f, t, a] of [
      ["4471", "5530", "100.00"],
      ["5530", "9902", "0.01"],
      ["9902", "4471", "3200.00"],
    ] as const) {
      const res = transfer(ok(f, t, a), s);
      ids.push(field(node(res), "confirmationId").text!);
      s = okState(res);
      expect(total(s)).toBe(t0);
    }
    expect(ids).toEqual(["GW-1001", "GW-1002", "GW-1003"]);
    expect(s.version).toBe(3);
    expect(s.nextConfirmation).toBe(1004);
    expect(s.txns.slice(-2).map((t) => t.id)).toEqual(["t-9902-08", "t-4471-08"]);
    expect(new Set(s.txns.map((t) => t.id)).size).toBe(s.txns.length);
  });

  describe("faults", () => {
    it("Invalid request when a param is missing", () => {
      expect(fault(transfer({ fromAccount: "4471", toAccount: "5530" }))).toBe("Invalid request");
      expect(fault(transfer({ fromAccount: "4471", amount: "1" }))).toBe("Invalid request");
      expect(fault(transfer({ toAccount: "5530", amount: "1" }))).toBe("Invalid request");
    });

    it.each([
      ["array", ["4471"]],
      ["object", { a: "1" }],
      ["number", 5],
      ["null", null],
    ])("Invalid request for %s param values", (_n, v) => {
      expect(fault(transfer({ ...ok("4471", "5530", "1"), amount: v }))).toBe("Invalid request");
      expect(fault(transfer({ ...ok("4471", "5530", "1"), fromAccount: v }))).toBe("Invalid request");
      expect(fault(transfer({ ...ok("4471", "5530", "1"), toAccount: v }))).toBe("Invalid request");
    });

    it("Invalid request for any non-string extra param", () => {
      expect(fault(transfer({ ...ok("4471", "5530", "1"), extra: ["x"] }))).toBe("Invalid request");
    });

    it.each(["abc", "", "0", "0.00", "-5", "1.234", "1e3", " 1", "1,5"])(
      "Invalid amount for %j",
      (a) => {
        expect(fault(transfer(ok("4471", "5530", a)))).toBe("Invalid amount");
      },
    );

    it.each([
      ["from", { fromAccount: "x" }],
      ["to", { toAccount: "<b>" }],
      ["from empty", { fromAccount: "" }],
      ["to long", { toAccount: "1234567890123" }],
    ])("Invalid account id (%s)", (_n, over) => {
      expect(fault(transfer({ ...ok("4471", "5530", "1"), ...over }))).toBe("Invalid account id");
    });

    it("rejects transfer to the same account", () => {
      expect(fault(transfer(ok("4471", "4471", "1")))).toBe("Cannot transfer to the same account");
    });

    it("reports unknown source then unknown destination", () => {
      expect(fault(transfer(ok("999", "5530", "1")))).toBe("Account 999 not found");
      expect(fault(transfer(ok("4471", "888", "1")))).toBe("Account 888 not found");
      expect(fault(transfer(ok("999", "888", "1")))).toBe("Account 999 not found");
    });

    it("rejects closed source and closed destination", () => {
      const s = seedState();
      s.accounts[0].status = "CLOSED";
      expect(fault(transfer(ok("4471", "5530", "1"), s))).toBe("Account 4471 is closed");
      expect(fault(transfer(ok("5530", "4471", "1"), s))).toBe("Account 4471 is closed");
    });

    it("rejects an amount above the source balance", () => {
      expect(fault(transfer(ok("4471", "5530", "12450.01")))).toBe("Insufficient funds");
      expect(fault(transfer(ok("7718", "5530", "0.01")))).toBe("Insufficient funds");
    });
  });

  describe("check order", () => {
    it("params are strings before everything else", () => {
      expect(fault(transfer({ fromAccount: "x", toAccount: "x", amount: ["bad"] }))).toBe(
        "Invalid request",
      );
    });

    it("invalid amount before invalid account id", () => {
      expect(fault(transfer(ok("x", "y", "0")))).toBe("Invalid amount");
    });

    it("invalid account id before same account", () => {
      expect(fault(transfer(ok("abc", "abc", "1")))).toBe("Invalid account id");
    });

    it("same account before unknown account", () => {
      expect(fault(transfer(ok("999", "999", "1")))).toBe("Cannot transfer to the same account");
    });

    it("source not found before destination not found", () => {
      expect(fault(transfer(ok("999", "888", "1")))).toBe("Account 999 not found");
    });

    it("destination not found before closed source", () => {
      const s = seedState();
      s.accounts[0].status = "CLOSED";
      expect(fault(transfer(ok("4471", "888", "1"), s))).toBe("Account 888 not found");
    });

    it("closed source before closed destination", () => {
      const s = seedState();
      s.accounts[0].status = "CLOSED";
      s.accounts[1].status = "CLOSED";
      expect(fault(transfer(ok("4471", "5530", "1"), s))).toBe("Account 4471 is closed");
    });

    it("closed accounts before insufficient funds", () => {
      const s = seedState();
      s.accounts[1].status = "CLOSED";
      expect(fault(transfer(ok("4471", "5530", "99999.00"), s))).toBe("Account 5530 is closed");
    });

    it("invalid amount before unknown account", () => {
      expect(fault(transfer(ok("999", "888", "abc")))).toBe("Invalid amount");
    });
  });

  it("does not echo hostile ids in faults", () => {
    const msg = fault(transfer(ok("<script>", "5530", "1")));
    expect(msg).not.toContain("<");
  });
});
