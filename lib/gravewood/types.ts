export type AccountStatus = "OPEN" | "CLOSED";

export type Account = {
  id: string;
  name: string;
  balanceCents: number;
  status: AccountStatus;
  openedOn: string;
  closedAt?: string;
  address?: string;
};

export type Txn = {
  id: string;
  accountId: string;
  ts: string;
  description: string;
  amountCents: number;
  memo: string | null;
};

export type BankState = {
  accounts: Account[];
  txns: Txn[];
  nextConfirmation: number;
  /** Optimistic concurrency counter; starts at 0. */
  version: number;
};

export type HandlerResult =
  | { ok: true; state: BankState; xml: string; status: 200 }
  | { ok: false; state: BankState; xml: string; status: 500 | 400 | 413 };
