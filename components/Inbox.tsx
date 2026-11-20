"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { listApprovals, type ApprovalItem } from "../lib/ui/approvals-client";
import { usePolling } from "../lib/ui/poll";
import { getOwnerToken } from "../lib/ui/token-store";
import { useApprove } from "../lib/ui/use-approve";
import { CandleHold } from "./CandleHold";
import { RiskBadge } from "./RiskBadge";

interface InboxProps {
  serviceId: string;
  isDemo: boolean;
}

const subscribeNever = (): (() => void) => () => undefined;

const CELL_MAX = 200;
const RESOLVED_MAX = 5;
const POLL_MS = 2000;

function truncate(text: string): string {
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX)}…` : text;
}

/** Plain text for one argument cell. Strings are shown as is; everything else as compact JSON. */
export function formatCell(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return truncate(json ?? String(value));
}

function argRows(args: unknown): Array<[string, string]> {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, formatCell(v)]);
  }
  if (args === undefined || args === null) return [];
  return [["value", formatCell(args)]];
}

function remainingLabel(expiresAt: string, now: number): { text: string; expired: boolean } {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { text: "expired", expired: true };
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return { text: `${m}:${s} left`, expired: false };
}

function ArgsTable({ args }: { args: unknown }) {
  const rows = argRows(args);
  if (rows.length === 0) return <p className="text-sm text-muted">No arguments.</p>;
  return (
    <table className="w-full table-fixed border-collapse text-left font-mono text-xs">
      <caption className="sr-only">Arguments</caption>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key} className="border-t border-border">
            <th scope="row" className="w-1/3 break-words py-1 pr-3 align-top font-medium text-muted">
              {key}
            </th>
            <td className="break-words py-1 align-top text-text">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface RowProps {
  serviceId: string;
  approval: ApprovalItem;
  ownerToken: string | null;
  now: number;
}

function PendingRow({ serviceId, approval, ownerToken, now }: RowProps) {
  const ids = useId();
  const approve = useApprove(serviceId, approval.id, { ownerToken });
  const [note, setNote] = useState("");
  const [read, setRead] = useState(false);
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);
  const remaining = remainingLabel(approval.expiresAt, now);
  const done = approve.status === "released";
  const busy = approve.status === "sending";
  const locked = busy || done || approval.status === "expired";

  const send = async (kind: "approve" | "deny"): Promise<void> => {
    const result = await (kind === "approve" ? approve.approve(note) : approve.deny(note));
    if (result.ok) setDecision(kind);
    else throw new Error(result.message);
  };

  return (
    <li className="space-y-3 rounded-md border border-border bg-surface p-4" data-approval={approval.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-base text-spectral">{approval.tool}</h3>
        <RiskBadge risk={approval.risk} />
        <span className="ml-auto text-sm text-muted" data-testid="remaining">
          {remaining.text}
        </span>
      </div>
      <p className="break-words text-sm text-text">{approval.reason}</p>
      <ArgsTable args={approval.args} />

      {done ? (
        <p role="status" className="text-sm text-candle">
          {decision === "deny" ? "Denied" : "Released"}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor={`${ids}-note`} className="block text-sm text-muted">
              Note (optional)
            </label>
            <input
              id={`${ids}-note`}
              type="text"
              maxLength={200}
              value={note}
              disabled={locked}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
            />
          </div>

          <CandleHold disabled={locked} onRelease={() => send("approve")} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={read}
                disabled={locked}
                onChange={(e) => setRead(e.target.checked)}
              />
              I have read the arguments and approve this call
            </label>
            <button
              type="button"
              disabled={locked || !read}
              onClick={() => void send("approve").catch(() => undefined)}
              className="rounded-md border border-candle/60 px-3 py-1 text-sm text-candle disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => void send("deny").catch(() => undefined)}
              className="rounded-md border border-border px-3 py-1 text-sm text-text disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-vengeful">
        {approve.status === "error" ? approve.message : ""}
      </p>
    </li>
  );
}

export function Inbox({ serviceId, isDemo }: InboxProps) {
  // undefined = not read yet (server render and hydration), null = no token.
  const token = useSyncExternalStore(
    subscribeNever,
    () => getOwnerToken(serviceId),
    (): string | null | undefined => undefined,
  );
  const [approvals, setApprovals] = useState<ApprovalItem[] | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const allowed = token !== undefined && (isDemo || token !== null);

  useEffect(() => {
    if (!allowed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [allowed]);

  const load = async (signal: AbortSignal): Promise<boolean> => {
    const result = await listApprovals(serviceId, { ownerToken: token ?? null, signal });
    if (signal.aborted) return true;
    if (result.ok) {
      setApprovals(result.approvals);
      setPollFailed(false);
      return true;
    }
    setPollFailed(true);
    return false;
  };

  // The poller starts before the token is read, so load once as soon as access is known.
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setNow(Date.now());
      void load(controller.signal);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load only closes over serviceId and token
  }, [allowed, serviceId, token]);

  usePolling(async (signal) => {
    if (!allowed) return;
    if (!(await load(signal))) throw new Error("poll failed");
  }, POLL_MS);

  const heading = (
    <h2 id="inbox-heading" className="text-2xl text-text">
      Held calls
    </h2>
  );

  if (token === undefined) {
    return <section aria-labelledby="inbox-heading" className="space-y-4">{heading}</section>;
  }

  if (!allowed) {
    return (
      <section aria-labelledby="inbox-heading" className="space-y-4">
        {heading}
        <p role="status" className="text-muted">
          Only the owner can release calls.
        </p>
      </section>
    );
  }

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const resolved = (approvals ?? []).filter((a) => a.status !== "pending").slice(0, RESOLVED_MAX);

  return (
    <section aria-labelledby="inbox-heading" className="space-y-4">
      {heading}
      {pollFailed ? <p className="text-sm text-muted">Listening for the spirits…</p> : null}
      <div aria-live="polite">
        {approvals !== null && pending.length === 0 ? (
          <p className="text-muted">No spirits are waiting.</p>
        ) : null}
      </div>
      {pending.length > 0 ? (
        <ul className="space-y-4">
          {pending.map((a) => (
            <PendingRow key={a.id} serviceId={serviceId} approval={a} ownerToken={token} now={now} />
          ))}
        </ul>
      ) : null}
      {resolved.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted">Resolved</summary>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {resolved.map((a) => (
              <li key={a.id}>
                <span className="font-mono">{a.tool}</span> — {a.status}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
