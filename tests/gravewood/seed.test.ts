import { describe, expect, it } from "vitest";
import { seedState } from "../../lib/gravewood/seed";

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("seedState", () => {
  it("balances sum to 6365000 cents (63650.00)", () => {
    const total = seedState().accounts.reduce((s, a) => s + a.balanceCents, 0);
    expect(total).toBe(6365000);
  });

  it("has the four expected account ids, all OPEN, nextConfirmation 1001, version 0", () => {
    const s = seedState();
    expect(s.accounts.map((a) => a.id)).toEqual(["4471", "5530", "9902", "7718"]);
    expect(s.accounts.every((a) => a.status === "OPEN")).toBe(true);
    expect(s.nextConfirmation).toBe(1001);
    expect(s.version).toBe(0);
  });

  it("has 6 txns per account and unique txn ids", () => {
    const s = seedState();
    for (const a of s.accounts) {
      expect(s.txns.filter((t) => t.accountId === a.id)).toHaveLength(6);
    }
    expect(s.txns).toHaveLength(24);
    expect(new Set(s.txns.map((t) => t.id)).size).toBe(s.txns.length);
  });

  it("signed txn sums equal each account balance", () => {
    const s = seedState();
    for (const a of s.accounts) {
      const sum = s.txns.filter((t) => t.accountId === a.id).reduce((x, t) => x + t.amountCents, 0);
      expect(sum).toBe(a.balanceCents);
    }
  });

  it("timestamps are fixed ISO strings, strictly increasing per account", () => {
    const s = seedState();
    for (const a of s.accounts) {
      const ts = s.txns.filter((t) => t.accountId === a.id).map((t) => t.ts);
      for (const t of ts) expect(t).toMatch(TS_RE);
      for (let i = 1; i < ts.length; i++) expect(ts[i] > ts[i - 1]).toBe(true);
    }
  });

  it("returns deep-equal but independent objects on each call", () => {
    const a = seedState();
    const b = seedState();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.accounts).not.toBe(b.accounts);
    expect(a.txns).not.toBe(b.txns);
    expect(a.accounts[0]).not.toBe(b.accounts[0]);
    expect(a.txns[0]).not.toBe(b.txns[0]);
  });

  it("mutating one result does not affect another", () => {
    const a = seedState();
    const b = seedState();
    a.accounts[0].balanceCents = 1;
    a.txns[0].description = "changed";
    a.txns.push({ id: "x", accountId: "4471", ts: "2030-01-01T00:00:00Z", description: "x", amountCents: 1, memo: null });
    a.accounts.pop();
    a.nextConfirmation = 5;
    const c = seedState();
    expect(b).toEqual(c);
    expect(b.accounts).toHaveLength(4);
    expect(b.txns).toHaveLength(24);
  });

  it("dormant account 7718 is the oldest, empty, and closed out by 2022", () => {
    const s = seedState();
    const dormant = s.accounts.find((a) => a.id === "7718");
    expect(dormant).toBeDefined();
    expect(dormant?.openedOn).toBe("2012-03-01");
    expect(dormant?.balanceCents).toBe(0);
    for (const a of s.accounts) {
      if (a.id !== "7718") expect(dormant!.openedOn < a.openedOn).toBe(true);
    }
    const txns = s.txns.filter((t) => t.accountId === "7718");
    const last = txns[txns.length - 1];
    expect(last.description).toBe("Closing withdrawal");
    expect(Number(last.ts.slice(0, 4))).toBeLessThanOrEqual(2022);
  });
});
