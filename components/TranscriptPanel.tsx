"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fourSteps, decisionLabel, formatDuration, formatTime, outcomeLabel } from "../lib/ui/transcript-view";
import { listTranscripts, type TranscriptItem } from "../lib/ui/transcripts-client";
import { usePolling } from "../lib/ui/poll";
import { getOwnerToken } from "../lib/ui/token-store";

interface TranscriptPanelProps {
  serviceId: string;
  isDemo: boolean;
}

const subscribeNever = (): (() => void) => () => undefined;

const POLL_MS = 2000;
const MAX_SHOWN = 30;
const MAX_ANNOUNCED = 5;

const DECISION_COLORS: Record<TranscriptItem["decision"], string> = {
  allow: "text-spectral border-spectral/50",
  hold: "text-candle border-candle/50",
  block: "text-vengeful border-vengeful/50",
  ghost: "text-muted border-border",
};

/** Tool names and decision labels only. Never argument values. */
export function announcement(fresh: TranscriptItem[]): string {
  if (fresh.length === 0) return "";
  const parts = fresh
    .slice(0, MAX_ANNOUNCED)
    .map((e) => `${e.tool} ${decisionLabel(e.decision).label.toLowerCase()}`);
  const more = fresh.length > MAX_ANNOUNCED ? `, and ${fresh.length - MAX_ANNOUNCED} more` : "";
  const noun = fresh.length === 1 ? "call" : "calls";
  return `${fresh.length} new ${noun}: ${parts.join(", ")}${more}`;
}

function Entry({ entry }: { entry: TranscriptItem }) {
  const decision = decisionLabel(entry.decision);
  return (
    <li className="rounded-md border border-border bg-surface" data-entry={entry.id}>
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-candle">
          <time dateTime={entry.ts} className="font-mono text-muted">
            {formatTime(entry.ts)}
          </time>
          <span className="font-mono text-spectral" data-tool>{entry.tool}</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${DECISION_COLORS[entry.decision]}`}
            data-decision={entry.decision}
          >
            <span aria-hidden="true">{decision.icon}</span>
            <span>{decision.label}</span>
          </span>
          <span className="text-text">{outcomeLabel(entry.outcome)}</span>
          <span className="ml-auto font-mono text-muted">{formatDuration(entry.durationMs)}</span>
        </summary>
        <ol className="space-y-3 border-t border-border p-3">
          {fourSteps(entry).map((step) => (
            <li key={step.title} className="space-y-1">
              <h4 className="text-xs uppercase tracking-wide text-muted">{step.title}</h4>
              <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-bg p-2 font-mono text-xs text-text">
                {step.body}
              </pre>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

export function TranscriptPanel({ serviceId, isDemo }: TranscriptPanelProps) {
  // undefined = not read yet (server render and hydration), null = no token.
  const token = useSyncExternalStore(
    subscribeNever,
    () => getOwnerToken(serviceId),
    (): string | null | undefined => undefined,
  );
  const [entries, setEntries] = useState<TranscriptItem[] | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [message, setMessage] = useState("");
  const seen = useRef<Set<string> | null>(null);

  const allowed = token !== undefined && (isDemo || token !== null);

  const load = async (signal: AbortSignal): Promise<boolean> => {
    const result = await listTranscripts(serviceId, { ownerToken: token ?? null, signal });
    if (signal.aborted) return true;
    if (!result.ok) {
      setPollFailed(true);
      return false;
    }
    const known = seen.current;
    // The first load is the baseline: only later arrivals are announced.
    const fresh = known === null ? [] : result.entries.filter((e) => !known.has(e.id));
    const next = known ?? new Set<string>();
    for (const e of result.entries) next.add(e.id);
    seen.current = next;
    setMessage(announcement(fresh));
    setEntries(result.entries);
    setPollFailed(false);
    return true;
  };

  // The poller starts before the token is read, so load once as soon as access is known.
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
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
    <h2 id="transcript-heading" className="text-2xl text-text">
      Ouija transcript
    </h2>
  );

  if (token === undefined) {
    return <section aria-labelledby="transcript-heading" className="space-y-4">{heading}</section>;
  }

  if (!allowed) {
    return (
      <section aria-labelledby="transcript-heading" className="space-y-4">
        {heading}
        <p role="status" className="text-muted">
          Only the owner can read this transcript.
        </p>
      </section>
    );
  }

  const shown = (entries ?? []).slice(0, MAX_SHOWN);

  return (
    <section
      aria-labelledby="transcript-heading"
      className="space-y-4 rounded-md border border-border bg-surface/60 p-4 sm:p-6"
    >
      {heading}
      <p aria-live="polite" className="sr-only" data-testid="transcript-live">
        {message}
      </p>
      {pollFailed ? <p className="text-sm text-muted">Listening for the spirits…</p> : null}
      {entries !== null && shown.length === 0 ? (
        <p className="text-muted">No one has called this spirit yet.</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="space-y-2" aria-label="Calls, newest first">
          {shown.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
