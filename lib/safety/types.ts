import type { Risk } from "../soap/types";

export type Effect = "allow" | "hold" | "block";
export type CondOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains";

export type Condition = { field: string; op: CondOp; value: string | number | boolean };

export type Rule = {
  id: string;
  /** Operation name or "*". */
  operation: string;
  when?: Condition;
  effect: Effect;
  /** <= 200 chars. */
  reason: string;
};

export type Decision = {
  action: "allow" | "hold" | "block" | "ghost";
  ruleId?: string;
  reason: string;
};

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed";

/** Stores the real (unredacted) args; the UI-facing API must return redact(args). */
export type Approval = {
  id: string;
  serviceId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  note?: string;
};

export type TranscriptEntry = {
  id: string;
  ts: string;
  tool: string;
  args: unknown;
  risk: Risk;
  decision: Decision["action"];
  ruleId?: string;
  approvalId?: string;
  outcome: "ok" | "fault" | "error" | "held" | "blocked" | "ghost";
  durationMs: number;
  soapRequest?: string;
  soapResponse?: string;
  summary: string;
};
