import { formatCents, formatSignedCents, parseAmountToCents } from "./money";
import type { Account, BankState, HandlerResult } from "./types";
import { buildEnvelope, buildFault, parseRequest, safeId, type XmlNode } from "./xml";

export type Params = Record<string, unknown>;

export type OpResult =
  | { ok: true; state: BankState; node: XmlNode }
  | { ok: false; kind: "Client" | "Server"; message: string };

export type Fail = Extract<OpResult, { ok: false }>;

export function clientFault(message: string): Fail {
  return { ok: false, kind: "Client", message };
}

const INVALID_REQUEST = "Invalid request";
const INVALID_ACCOUNT_ID = "Invalid account id";
const INVALID_DATE = "Invalid date";
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

// ---------- param helpers (reused by other operations) ----------

/** Every param value must be a string; arrays and objects are rejected. */
export function checkParamsAreStrings(params: Params): Fail | null {
  for (const v of Object.values(params)) {
    if (typeof v !== "string") return clientFault(INVALID_REQUEST);
  }
  return null;
}

/** Required string param. Missing or non-string -> Client "Invalid request". */
export function requireString(params: Params, name: string): string | Fail {
  const v = Object.hasOwn(params, name) ? params[name] : undefined;
  return typeof v === "string" ? v : clientFault(INVALID_REQUEST);
}

/** Optional string param. Missing -> undefined; non-string -> Client "Invalid request". */
export function optionalString(params: Params, name: string): string | undefined | Fail {
  if (!Object.hasOwn(params, name)) return undefined;
  const v = params[name];
  return typeof v === "string" ? v : clientFault(INVALID_REQUEST);
}

/** Required account id param: must match /^[0-9]{1,12}$/. */
export function requireAccountId(params: Params, name: string): string | Fail {
  const v = requireString(params, name);
  if (typeof v !== "string") return v;
  const id = safeId(v);
  return id === null ? clientFault(INVALID_ACCOUNT_ID) : id;
}

export function findAccount(state: BankState, id: string): Account | undefined {
  return state.accounts.find((a) => a.id === id);
}

export function accountNotFound(id: string): Fail {
  const safe = safeId(id);
  return clientFault(safe === null ? "Account not found" : `Account ${safe} not found`);
}

/** True only for real calendar dates in YYYY-MM-DD form. */
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function text(name: string, value: string): XmlNode {
  return { name, text: value };
}

// ---------- read operations ----------

export function listAccounts(state: BankState): OpResult {
  const children: XmlNode[] = state.accounts.map((a) => ({
    name: "account",
    children: [
      text("id", a.id),
      text("name", a.name),
      text("balance", formatCents(a.balanceCents)),
      text("status", a.status),
      text("openedOn", a.openedOn),
    ],
  }));
  return { ok: true, state, node: { name: "ListAccountsResponse", children } };
}

export function getBalance(state: BankState, params: Params, nowIso: string): OpResult {
  const bad = checkParamsAreStrings(params);
  if (bad) return bad;
  const id = requireAccountId(params, "accountId");
  if (typeof id !== "string") return id;
  const account = findAccount(state, id);
  if (!account) return accountNotFound(id);
  return {
    ok: true,
    state,
    node: {
      name: "GetBalanceResponse",
      children: [
        text("accountId", account.id),
        text("balance", formatCents(account.balanceCents)),
        text("asOf", nowIso),
      ],
    },
  };
}

export function getStatement(state: BankState, params: Params, nowIso: string): OpResult {
  void nowIso;
  const bad = checkParamsAreStrings(params);
  if (bad) return bad;
  const id = requireAccountId(params, "accountId");
  if (typeof id !== "string") return id;
  const from = optionalString(params, "fromDate");
  if (typeof from === "object") return from;
  const to = optionalString(params, "toDate");
  if (typeof to === "object") return to;
  if (from !== undefined && !isValidDate(from)) return clientFault(INVALID_DATE);
  if (to !== undefined && !isValidDate(to)) return clientFault(INVALID_DATE);
  if (from !== undefined && to !== undefined && from > to) {
    return clientFault("fromDate is after toDate");
  }
  const account = findAccount(state, id);
  if (!account) return accountNotFound(id);

  const rows = state.txns
    .filter((t) => {
      if (t.accountId !== id) return false;
      const day = t.ts.slice(0, 10);
      return (from === undefined || day >= from) && (to === undefined || day <= to);
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const children: XmlNode[] = [text("accountId", account.id)];
  for (const t of rows) {
    children.push({
      name: "transaction",
      children: [
        text("id", t.id),
        text("timestamp", t.ts),
        text("description", t.description),
        text("amount", formatSignedCents(t.amountCents)),
        t.memo === null ? { name: "memo", nil: true } : text("memo", t.memo),
      ],
    });
  }
  return { ok: true, state, node: { name: "GetStatementResponse", children } };
}

// ---------- write operations ----------

function accountClosed(id: string): Fail {
  return clientFault(`Account ${id} is closed`);
}

/** Next transaction id for an account: t-<acct>-NN (existing count + 1, zero padded to 2). */
function nextTxnId(state: BankState, accountId: string): string {
  const n = state.txns.filter((t) => t.accountId === accountId).length + 1;
  return `t-${accountId}-${String(n).padStart(2, "0")}`;
}

/** Moves funds between two open accounts. Pure: returns a new state, never mutates the input. */
export function transferFunds(state: BankState, params: Params, nowIso: string): OpResult {
  const bad = checkParamsAreStrings(params);
  if (bad) return bad;
  const amountStr = requireString(params, "amount");
  const fromRaw = requireString(params, "fromAccount");
  const toRaw = requireString(params, "toAccount");
  if (typeof amountStr !== "string") return amountStr;
  if (typeof fromRaw !== "string") return fromRaw;
  if (typeof toRaw !== "string") return toRaw;

  const cents = parseAmountToCents(amountStr);
  if (cents === null) return clientFault("Invalid amount");

  const from = requireAccountId(params, "fromAccount");
  if (typeof from !== "string") return from;
  const to = requireAccountId(params, "toAccount");
  if (typeof to !== "string") return to;

  if (from === to) return clientFault("Cannot transfer to the same account");

  const src = findAccount(state, from);
  if (!src) return accountNotFound(from);
  const dst = findAccount(state, to);
  if (!dst) return accountNotFound(to);
  if (src.status === "CLOSED") return accountClosed(from);
  if (dst.status === "CLOSED") return accountClosed(to);
  if (cents > src.balanceCents) return clientFault("Insufficient funds");

  const next = structuredClone(state);
  const nSrc = findAccount(next, from) as Account;
  const nDst = findAccount(next, to) as Account;
  const ts = nowIso.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "");
  const srcTxnId = nextTxnId(next, from);
  const dstTxnId = nextTxnId(next, to);

  nSrc.balanceCents -= cents;
  nDst.balanceCents += cents;
  next.txns.push(
    { id: srcTxnId, accountId: from, ts, description: `Transfer to ${to}`, amountCents: -cents, memo: null },
    { id: dstTxnId, accountId: to, ts, description: `Transfer from ${from}`, amountCents: cents, memo: null },
  );
  const confirmationId = `GW-${next.nextConfirmation}`;
  next.nextConfirmation += 1;
  next.version += 1;

  return {
    ok: true,
    state: next,
    node: {
      name: "TransferFundsResponse",
      children: [
        text("confirmationId", confirmationId),
        text("fromBalance", formatCents(nSrc.balanceCents)),
        text("toBalance", formatCents(nDst.balanceCents)),
      ],
    },
  };
}
const ADDRESS_MAX = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
/** Updates the address of an open account. Pure: returns a new state, never mutates the input. */
export function updateAddress(state: BankState, params: Params, nowIso: string): OpResult {
  void nowIso;
  const bad = checkParamsAreStrings(params);
  if (bad) return bad;
  const id = requireAccountId(params, "accountId");
  if (typeof id !== "string") return id;
  const raw = requireString(params, "address");
  if (typeof raw !== "string") return raw;
  const account = findAccount(state, id);
  if (!account) return accountNotFound(id);
  if (account.status === "CLOSED") return accountClosed(id);
  const address = raw.trim();
  if (address === "" || CONTROL_CHARS_RE.test(address)) return clientFault("Invalid address");
  if (Array.from(address).length > ADDRESS_MAX) return clientFault("Address too long");
  const next = structuredClone(state);
  (findAccount(next, id) as Account).address = address;
  next.version += 1;
  return {
    ok: true,
    state: next,
    node: { name: "UpdateAddressResponse", children: [text("updated", "true")] },
  };
}
/** Closes an account; its balance stays on the account. Pure: never mutates the input. */
export function closeAccount(state: BankState, params: Params, nowIso: string): OpResult {
  const bad = checkParamsAreStrings(params);
  if (bad) return bad;
  const id = requireAccountId(params, "accountId");
  if (typeof id !== "string") return id;
  const account = findAccount(state, id);
  if (!account) return accountNotFound(id);
  if (account.status === "CLOSED") return accountClosed(id);
  const closedAt = nowIso.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "");
  const next = structuredClone(state);
  const target = findAccount(next, id) as Account;
  target.status = "CLOSED";
  target.closedAt = closedAt;
  next.version += 1;
  return {
    ok: true,
    state: next,
    node: {
      name: "CloseAccountResponse",
      children: [text("closed", "true"), text("closedAt", closedAt)],
    },
  };
}

// ---------- dispatch ----------

type Operation = (state: BankState, params: Params, nowIso: string) => OpResult;

const OPERATIONS: Readonly<Record<string, Operation>> = {
  ListAccounts: (state) => listAccounts(state),
  GetBalance: getBalance,
  GetStatement: getStatement,
  TransferFunds: transferFunds,
  UpdateAddress: updateAddress,
  CloseAccount: closeAccount,
};

function faultResult(state: BankState, kind: "Client" | "Server", message: string): HandlerResult {
  return { ok: false, state, xml: buildFault(kind, message), status: 500 };
}

/** Normalises a SOAPAction header: trims, strips surrounding double quotes, trims again. */
function normaliseSoapAction(raw: string | null): string | null {
  if (raw === null) return null;
  let v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
  return v === "" ? null : v;
}

/**
 * Pure entry point: parse, dispatch, check SOAPAction, run the operation.
 * On any failure the original state object is returned untouched.
 */
export function handleSoap(
  state: BankState,
  soapAction: string | null,
  bodyXml: string,
  nowIso: string,
): HandlerResult {
  try {
    const req = parseRequest(bodyXml);
    if (!req.ok) return faultResult(state, "Client", "Malformed request");

    if (!Object.hasOwn(OPERATIONS, req.operation)) {
      return faultResult(state, "Client", "Unknown operation");
    }

    const action = normaliseSoapAction(soapAction);
    if (action !== null && action !== `urn:gravewood:${req.operation}`) {
      return faultResult(state, "Client", "SOAPAction mismatch");
    }

    const res = OPERATIONS[req.operation](state, req.params, nowIso);
    if (!res.ok) return faultResult(state, res.kind, res.message);
    return { ok: true, state: res.state, xml: buildEnvelope(res.node), status: 200 };
  } catch {
    return faultResult(state, "Server", "Internal error");
  }
}
