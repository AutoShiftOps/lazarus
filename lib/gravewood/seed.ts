import type { Account, BankState, Txn } from "./types";

type TxnSeed = readonly [ts: string, description: string, amountCents: number, memo: string | null];

type AccountSeed = {
  id: string;
  name: string;
  balanceCents: number;
  openedOn: string;
  txns: readonly TxnSeed[];
};

const ACCOUNT_SEEDS: readonly AccountSeed[] = [
  {
    id: "4471",
    name: "Priya Raman — Operating",
    balanceCents: 1245000,
    openedOn: "2019-04-02",
    txns: [
      ["2019-04-02T09:15:00Z", "Opening deposit", 1000000, null],
      ["2019-09-17T14:30:00Z", "Client payment - Hollow Creek Supplies", 450000, "Invoice 2041"],
      ["2020-02-05T11:00:00Z", "Office rent", -120000, null],
      ["2020-08-21T16:45:00Z", "Refund - Lantern Print Co", 80000, "Order cancelled"],
      ["2021-01-12T10:20:00Z", "Software subscription", -75000, null],
      ["2021-06-30T13:05:00Z", "Equipment purchase", -90000, "Label printer"],
    ],
  },
  {
    id: "5530",
    name: "Priya Raman — Savings",
    balanceCents: 4800000,
    openedOn: "2019-04-02",
    txns: [
      ["2019-04-02T09:40:00Z", "Opening deposit", 4000000, null],
      ["2019-12-20T12:00:00Z", "Transfer in - year-end reserve", 1000000, "Reserve top-up"],
      ["2020-07-01T08:30:00Z", "Interest credit", 250000, null],
      ["2021-03-15T15:10:00Z", "Tax set-aside", -300000, "Quarterly estimate"],
      ["2021-11-08T09:55:00Z", "Transfer out - roof repair", -200000, null],
      ["2022-07-01T08:30:00Z", "Interest credit", 50000, null],
    ],
  },
  {
    id: "9902",
    name: "Gravewood Vendor Holdings",
    balanceCents: 320000,
    openedOn: "2020-06-10",
    txns: [
      ["2020-06-10T10:00:00Z", "Opening deposit", 500000, null],
      ["2020-10-14T13:25:00Z", "Receipt - Marrow Lane Freight", 120000, "Pallet shipment"],
      ["2021-02-26T09:00:00Z", "Supplier payment - Ashen Timber", -200000, null],
      ["2021-09-03T17:15:00Z", "Bank service fee", -60000, "Annual fee"],
      ["2022-04-19T11:40:00Z", "Receipt - Thistle Street Market", 30000, null],
      ["2022-12-05T14:05:00Z", "Utilities", -70000, "Warehouse power"],
    ],
  },
  {
    id: "7718",
    name: "Dormant Account (Old Mill Branch)",
    balanceCents: 0,
    openedOn: "2012-03-01",
    txns: [
      ["2012-03-01T09:00:00Z", "Opening deposit", 800000, null],
      ["2012-11-23T10:30:00Z", "Deposit - mill pension payout", 50000, "Pension"],
      ["2014-05-09T14:15:00Z", "Cash withdrawal", -150000, null],
      ["2016-08-30T11:50:00Z", "Deposit - cheque 0042", 100000, "Cheque 0042"],
      ["2018-01-18T15:00:00Z", "Cash withdrawal", -20000, null],
      ["2019-10-04T09:45:00Z", "Closing withdrawal", -780000, "Balance withdrawn, no further activity"],
    ],
  },
];

/** Returns a fresh, independent seeded bank state on every call. */
export function seedState(): BankState {
  const accounts: Account[] = ACCOUNT_SEEDS.map((a) => ({
    id: a.id,
    name: a.name,
    balanceCents: a.balanceCents,
    status: "OPEN",
    openedOn: a.openedOn,
  }));

  const txns: Txn[] = ACCOUNT_SEEDS.flatMap((a) =>
    a.txns.map(([ts, description, amountCents, memo], i) => ({
      id: `t-${a.id}-${String(i + 1).padStart(2, "0")}`,
      accountId: a.id,
      ts,
      description,
      amountCents,
      memo,
    })),
  );

  return { accounts, txns, nextConfirmation: 1001, version: 0 };
}
