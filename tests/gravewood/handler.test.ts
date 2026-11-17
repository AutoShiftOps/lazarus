import { describe, expect, it } from "vitest";
import {
  getBalance,
  getStatement,
  listAccounts,
  transferFunds,
  updateAddress,
  closeAccount,
  handleSoap,
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

describe("updateAddress", () => {
  function update(params: Record<string, unknown>, state: BankState = seedState()): OpResult {
    const snapshot = structuredClone(state);
    const res = updateAddress(state, params, NOW);
    expect(state).toEqual(snapshot);
    if (res.ok) expect(res.state).not.toBe(state);
    return res;
  }
  const addr = (accountId: string, address: unknown) => ({ accountId, address });
  const acct = (s: BankState, id: string) => s.accounts.find((a) => a.id === id)!;
  const total = (s: BankState) => s.accounts.reduce((sum, a) => sum + a.balanceCents, 0);

  it("stores the trimmed address, bumps version and returns updated=true", () => {
    const base = seedState();
    const res = update(addr("4471", "  12 Elm Street, Hollow Creek \t"), base);
    expect(node(res)).toEqual({
      name: "UpdateAddressResponse",
      children: [{ name: "updated", text: "true" }],
    });
    if (!res.ok) throw new Error("unreachable");
    expect(acct(res.state, "4471").address).toBe("12 Elm Street, Hollow Creek");
    expect(res.state.version).toBe(base.version + 1);
    expect(total(res.state)).toBe(total(base));
    expect(res.state.txns).toEqual(base.txns);
    expect(acct(base, "4471").address).toBeUndefined();
  });

  it("replaces an existing address", () => {
    const first = update(addr("4471", "A"));
    if (!first.ok) throw new Error("unreachable");
    const second = update(addr("4471", "B"), first.state);
    if (!second.ok) throw new Error("unreachable");
    expect(acct(second.state, "4471").address).toBe("B");
    expect(second.state.version).toBe(2);
  });

  it("accepts exactly 200 characters and rejects 201", () => {
    expect(update(addr("4471", "a".repeat(200))).ok).toBe(true);
    expect(fault(update(addr("4471", "a".repeat(201))))).toBe("Address too long");
  });

  it("measures length after trimming", () => {
    expect(update(addr("4471", ` ${"a".repeat(200)} `)).ok).toBe(true);
  });

  it("accepts unicode addresses and counts code points", () => {
    const res = update(addr("4471", "Ünïcödé 通り 12 🪦"));
    if (!res.ok) throw new Error("unreachable");
    expect(acct(res.state, "4471").address).toBe("Ünïcödé 通り 12 🪦");
    expect(update(addr("4471", "🪦".repeat(200))).ok).toBe(true);
    expect(fault(update(addr("4471", "🪦".repeat(201))))).toBe("Address too long");
  });

  it("rejects empty, whitespace-only and control character addresses", () => {
    expect(fault(update(addr("4471", "")))).toBe("Invalid address");
    expect(fault(update(addr("4471", "   \t ")))).toBe("Invalid address");
    expect(fault(update(addr("4471", "a\u0000b")))).toBe("Invalid address");
    expect(fault(update(addr("4471", "a\nb")))).toBe("Invalid address");
    expect(fault(update(addr("4471", "a\u007Fb")))).toBe("Invalid address");
  });

  it("faults on unknown account and closed account", () => {
    expect(fault(update(addr("999", "x")))).toBe("Account 999 not found");
    const s = seedState();
    s.accounts[0].status = "CLOSED";
    expect(fault(update(addr("4471", "x"), s))).toBe("Account 4471 is closed");
  });

  it("rejects bad ids and missing or non-string params", () => {
    expect(fault(update(addr("x", "a")))).toBe("Invalid account id");
    expect(fault(update({ accountId: "4471" }))).toBe("Invalid request");
    expect(fault(update(addr("4471", ["a"])))).toBe("Invalid request");
  });

  it("does not echo hostile ids in faults", () => {
    expect(fault(update(addr("<script>", "a")))).not.toContain("<");
  });
});

describe("closeAccount", () => {
  const NOW_MS = "2026-01-02T03:04:05.678Z";
  function close(
    params: Record<string, unknown>,
    state: BankState = seedState(),
    now = NOW,
  ): OpResult {
    const snapshot = structuredClone(state);
    const res = closeAccount(state, params, now);
    expect(state).toEqual(snapshot);
    if (res.ok) expect(res.state).not.toBe(state);
    return res;
  }
  const total = (s: BankState) => s.accounts.reduce((sum, a) => sum + a.balanceCents, 0);

  it("closes the account, keeps its balance, bumps version and returns closedAt without ms", () => {
    const base = seedState();
    const res = close({ accountId: "4471" }, base, NOW_MS);
    expect(node(res)).toEqual({
      name: "CloseAccountResponse",
      children: [
        { name: "closed", text: "true" },
        { name: "closedAt", text: NOW },
      ],
    });
    if (!res.ok) throw new Error("unreachable");
    const a = res.state.accounts.find((x) => x.id === "4471")!;
    expect(a.status).toBe("CLOSED");
    expect(a.closedAt).toBe(NOW);
    expect(a.balanceCents).toBe(1245000);
    expect(res.state.version).toBe(base.version + 1);
    expect(total(res.state)).toBe(total(base));
    expect(res.state.txns).toEqual(base.txns);
    expect(base.accounts[0].status).toBe("OPEN");
  });

  it("leaves other accounts untouched", () => {
    const base = seedState();
    const res = close({ accountId: "5530" }, base);
    if (!res.ok) throw new Error("unreachable");
    expect(res.state.accounts.filter((a) => a.id !== "5530")).toEqual(
      base.accounts.filter((a) => a.id !== "5530"),
    );
  });

  it("faults on a repeat close", () => {
    const first = close({ accountId: "4471" });
    if (!first.ok) throw new Error("unreachable");
    expect(fault(close({ accountId: "4471" }, first.state))).toBe("Account 4471 is closed");
  });

  it("makes a closed account reject address updates", () => {
    const first = close({ accountId: "4471" });
    if (!first.ok) throw new Error("unreachable");
    const res = updateAddress(first.state, { accountId: "4471", address: "x" }, NOW);
    expect(fault(res)).toBe("Account 4471 is closed");
  });

  it("faults on unknown account, bad id and bad params", () => {
    expect(fault(close({ accountId: "999" }))).toBe("Account 999 not found");
    expect(fault(close({ accountId: "x" }))).toBe("Invalid account id");
    expect(fault(close({}))).toBe("Invalid request");
    expect(fault(close({ accountId: ["4471"] }))).toBe("Invalid request");
  });

  it("does not echo hostile ids in faults", () => {
    expect(fault(close({ accountId: "<script>" }))).not.toContain("<");
  });
});

describe("handleSoap", () => {
  const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
  const prefixed = (p: string, inner: string) =>
    `<${p}:Envelope xmlns:${p}="${SOAP_NS}"><${p}:Body>${inner}</${p}:Body></${p}:Envelope>`;
  const defaultNs = (inner: string) =>
    `<Envelope xmlns="${SOAP_NS}"><Body>${inner}</Body></Envelope>`;
  const op = (name: string, fields = "") => `<${name} xmlns="urn:gravewood">${fields}</${name}>`;

  const faultXml = (kind: string, msg: string) =>
    `<soap:Fault><faultcode>soap:${kind}</faultcode><faultstring>${msg}</faultstring></soap:Fault>`;

  it.each([
    ["soap", (i: string) => prefixed("soap", i)],
    ["s", (i: string) => prefixed("s", i)],
    ["default", defaultNs],
  ])("runs all six operations end to end (%s prefix)", (_n, wrap) => {
    const s0 = seedState();
    const call = (state: BankState, name: string, fields = "") =>
      handleSoap(state, `"urn:gravewood:${name}"`, wrap(op(name, fields)), NOW);

    const list = call(s0, "ListAccounts");
    expect(list.ok).toBe(true);
    expect(list.status).toBe(200);
    expect(list.xml).toContain("<ListAccountsResponse");
    expect(list.xml).toContain("<account>");

    const bal = call(s0, "GetBalance", "<accountId>4471</accountId>");
    expect(bal.ok).toBe(true);
    expect(bal.xml).toContain("<GetBalanceResponse");
    expect(bal.xml).toContain("<accountId>4471</accountId>");
    expect(bal.xml).toContain(`<asOf>${NOW}</asOf>`);

    const stmt = call(s0, "GetStatement", "<accountId>4471</accountId>");
    expect(stmt.ok).toBe(true);
    expect(stmt.xml).toContain("<GetStatementResponse");
    expect(stmt.xml).toContain("<transaction>");

    const before = s0.accounts.find((a) => a.id === "4471")!.balanceCents;
    const tr = call(
      s0,
      "TransferFunds",
      "<fromAccount>4471</fromAccount><toAccount>5530</toAccount><amount>1.00</amount>",
    );
    expect(tr.ok).toBe(true);
    expect(tr.xml).toContain("<TransferFundsResponse");
    expect(tr.xml).toContain("<confirmationId>GW-");
    expect(tr.state).not.toBe(s0);
    expect(tr.state.accounts.find((a) => a.id === "4471")!.balanceCents).toBe(before - 100);

    const up = call(
      tr.state,
      "UpdateAddress",
      "<accountId>4471</accountId><address>1 Crypt Lane</address>",
    );
    expect(up.ok).toBe(true);
    expect(up.xml).toContain("<UpdateAddressResponse");
    expect(up.xml).toContain("<updated>true</updated>");

    const cl = call(up.state, "CloseAccount", "<accountId>4471</accountId>");
    expect(cl.ok).toBe(true);
    expect(cl.xml).toContain("<CloseAccountResponse");
    expect(cl.xml).toContain("<closed>true</closed>");
    expect(cl.state.accounts.find((a) => a.id === "4471")!.status).toBe("CLOSED");
  });

  describe("SOAPAction", () => {
    const body = prefixed("soap", op("GetBalance", "<accountId>4471</accountId>"));
    const s = seedState();

    it.each([
      ["quoted", '"urn:gravewood:GetBalance"'],
      ["unquoted", "urn:gravewood:GetBalance"],
      ["padded and quoted", '  "urn:gravewood:GetBalance" '],
      ["null", null],
      ["empty", ""],
      ["empty quotes", '""'],
      ["whitespace only", "   "],
    ])("accepts %s", (_n, action) => {
      const r = handleSoap(s, action, body, NOW);
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
    });

    it.each([
      ["wrong operation", '"urn:gravewood:ListAccounts"'],
      ["wrong namespace", "urn:other:GetBalance"],
      ["wrong case", "urn:gravewood:getbalance"],
      ["lone quote", '"'],
      ["inner whitespace", "urn:gravewood: GetBalance"],
    ])("rejects %s", (_n, action) => {
      const r = handleSoap(s, action, body, NOW);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(500);
      expect(r.xml).toContain(faultXml("Client", "SOAPAction mismatch"));
      expect(r.state).toBe(s);
    });
  });

  describe("faults", () => {
    const s = seedState();
    const expectFault = (
      r: ReturnType<typeof handleSoap>,
      kind: string,
      msg: string,
      state: BankState = s,
    ) => {
      expect(r.ok).toBe(false);
      expect(r.status).toBe(500);
      expect(r.xml).toContain(faultXml(kind, msg));
      expect(r.state).toBe(state);
    };

    it("unknown operation", () => {
      expectFault(
        handleSoap(s, null, prefixed("soap", op("DropTables")), NOW),
        "Client",
        "Unknown operation",
      );
    });

    it("operation names are case-sensitive and own-property only", () => {
      for (const name of ["getBalance", "toString", "hasOwnProperty"]) {
        expectFault(
          handleSoap(s, null, prefixed("soap", `<${name}/>`), NOW),
          "Client",
          "Unknown operation",
        );
      }
    });

    it("a prototype-named element never reaches an operation", () => {
      // fast-xml-parser rejects <constructor/> as malformed, so parseRequest reports that.
      expectFault(
        handleSoap(s, null, prefixed("soap", "<constructor/>"), NOW),
        "Client",
        "Malformed request",
      );
    });

    it("unknown operation is reported before a SOAPAction mismatch", () => {
      expectFault(
        handleSoap(s, "urn:x", prefixed("soap", op("Nope")), NOW),
        "Client",
        "Unknown operation",
      );
    });

    it("DOCTYPE body", () => {
      const xml = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>${prefixed("soap", op("ListAccounts"))}`;
      expectFault(handleSoap(s, null, xml, NOW), "Client", "Malformed request");
    });

    it.each([
      ["garbage", "not xml at all"],
      ["empty", ""],
      ["unclosed", "<a><b></a>"],
      ["no operation", prefixed("soap", "")],
      ["non-envelope root", "<root/>"],
    ])("%s input", (_n, xml) => {
      expectFault(handleSoap(s, null, xml, NOW), "Client", "Malformed request");
    });

    it("operation faults keep their message, HTTP 500 and the original state", () => {
      const r = handleSoap(
        s,
        null,
        prefixed("soap", op("GetBalance", "<accountId>9999</accountId>")),
        NOW,
      );
      expectFault(r, "Client", "Account 9999 not found");
    });

    it("a failed transfer returns the same state reference", () => {
      const r = handleSoap(
        s,
        null,
        prefixed(
          "soap",
          op(
            "TransferFunds",
            "<fromAccount>4471</fromAccount><toAccount>5530</toAccount><amount>999999999</amount>",
          ),
        ),
        NOW,
      );
      expectFault(r, "Client", "Insufficient funds");
    });

    it("a thrown error becomes a fixed Server fault with no leak", () => {
      const broken = { ...seedState(), accounts: "SECRET-LEAK-xyz" } as unknown as BankState;
      for (const [name, fields] of [
        ["ListAccounts", ""],
        ["GetBalance", "<accountId>4471</accountId>"],
      ] as const) {
        const r = handleSoap(broken, null, prefixed("soap", op(name, fields)), NOW);
        expectFault(r, "Server", "Internal error", broken);
        expect(r.xml).not.toMatch(/SECRET-LEAK|TypeError|is not a function|find|map|undefined/);
      }
    });
  });
});
