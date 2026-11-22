import type { TranscriptItem } from "./transcripts-client";

export const BODY_MAX = 4000;
export const NOT_SENT = "Not sent";

export type DecisionLabel = { label: "Allowed" | "Held" | "Blocked" | "Ghost" | "Collected"; icon: string };

/** Name of the built-in tool that collects a held call's result (same value as CHECK_APPROVAL_TOOL on the server). */
const CHECK_APPROVAL = "check_approval";

const DECISIONS: Record<TranscriptItem["decision"], DecisionLabel> = {
  allow: { label: "Allowed", icon: "✓" },
  hold: { label: "Held", icon: "⏳" },
  block: { label: "Blocked", icon: "⛔" },
  ghost: { label: "Ghost", icon: "👻" },
};

const OUTCOMES: Record<TranscriptItem["outcome"], string> = {
  ok: "Succeeded",
  fault: "SOAP fault",
  error: "Error",
  held: "Waiting for a human",
  blocked: "Stopped",
  ghost: "Rehearsed",
};

export function decisionLabel(decision: TranscriptItem["decision"]): DecisionLabel {
  return DECISIONS[decision];
}

/**
 * Label for one entry. A successful check_approval call collected the result of a held call; it was
 * not held itself, so it must not read "Held".
 */
export function entryDecisionLabel(entry: Pick<TranscriptItem, "tool" | "decision" | "outcome">): DecisionLabel {
  if (entry.tool === CHECK_APPROVAL && entry.outcome === "ok") return { label: "Collected", icon: "📥" };
  return decisionLabel(entry.decision);
}

export function outcomeLabel(outcome: TranscriptItem["outcome"]): string {
  return OUTCOMES[outcome];
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** HH:MM:SS in UTC, so server and browser agree. */
export function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toISOString().slice(11, 19);
}

function truncate(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}…` : text;
}

function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return "No arguments";
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

export type Step = { title: "JSON in" | "SOAP request" | "SOAP response" | "JSON out"; body: string };

export function fourSteps(entry: TranscriptItem): [Step, Step, Step, Step] {
  return [
    { title: "JSON in", body: truncate(prettyArgs(entry.args)) },
    { title: "SOAP request", body: truncate(entry.soapRequest ?? NOT_SENT) },
    { title: "SOAP response", body: truncate(entry.soapResponse ?? NOT_SENT) },
    { title: "JSON out", body: truncate(`Summary: ${entry.summary}`) },
  ];
}
