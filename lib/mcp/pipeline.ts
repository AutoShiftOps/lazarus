// lib/mcp/pipeline.ts
// The call pipeline (Requirements 3 and 8): decide what happens to one tools/call and record it.
// Everything is injected through Deps: no Redis client, env or global state is imported here.
//
// Step order:
//   1 rate limit (IP, then service; fails closed) -> 2 rules + settings (fail closed) -> 3 validate -> 4 decide -> 5 act -> 6 transcript (always).
// Upstream traffic only happens in the `allow` branch of step 5, or in executeApproved after a human approved a hold.

import { hit, type RateRedis } from "../rate-limit";
import type { Approvals } from "../safety/approvals";
import { decide } from "../safety/policy";
import type { Registry } from "../registry";
import { ghostResponse } from "../safety/ghost";
import type { Transcripts } from "../safety/transcript";
import type { Approval, Decision, TranscriptEntry } from "../safety/types";
import type { safePost } from "../soap/fetcher";
import { buildZodSchema } from "../soap/schema-generator";
import { fromEnvelope, toEnvelope } from "../soap/translator";
import type { OperationSchema, Risk, ServiceDefinition } from "../soap/types";
import { sanitizeText, type ToolDef } from "./tools";

export type McpToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type Deps = {
  registry: Pick<Registry, "getRules" | "getSettings">;
  transcripts: Pick<Transcripts, "appendTranscript">;
  approvals: Approvals;
  post: typeof safePost;
  /** Rate limiting counters: 10/min per IP per service, 30/min per service. */
  rateRedis: RateRedis;
  now: () => number;
  /** Injected so tests never wait in real time. */
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
};

export type CallContext = {
  service: ServiceDefinition;
  tool: ToolDef;
  args: unknown;
  clientIp: string;
};

export type CheckApprovalContext = {
  service: ServiceDefinition;
  tools: ToolDef[];
  /** Untrusted agent input; validated before use. */
  approvalId: unknown;
  clientIp: string;
};

export interface Pipeline {
  runCall(ctx: CallContext): Promise<McpToolResult>;
  /** The built-in `check_approval` tool: collects the outcome of a held call. Executes at most once. */
  runCheckApproval(ctx: CheckApprovalContext): Promise<McpToolResult>;
}

const CHECK_TOOL = "check_approval";
const MAX_APPROVAL_ID_CHARS = 64;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MSG_BAD_APPROVAL_ID = "Invalid approvalId.";
const MSG_APPROVAL_NOT_FOUND = "Approval not found.";
const MSG_ALREADY_EXECUTED = "This call was already executed.";

const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_FAULT_CHARS = 300;
const MAX_VALIDATION_CHARS = 500;
const MAX_RESULT_BYTES = 65_536;
const TRUNCATION_MARKER = "\n[result truncated]";

const SERVICE_LIMIT = 30;
const IP_LIMIT = 10;
const RATE_WINDOW_SEC = 60;
const MAX_KEY_PART_CHARS = 64;
const MSG_RATE_LIMITED = "Too many calls";
const MSG_RATE_UNAVAILABLE = "Rate limiting is unavailable. Nothing was sent.";
const MSG_NO_ANSWER = "The spirit did not answer.";
const MSG_UNAVAILABLE = "The service settings are unavailable. Nothing was sent.";
const MSG_INTERNAL = "Something went wrong inside Lazarus. Nothing was sent.";
const MSG_APPROVAL_STORE = "The approval store is unavailable. Nothing was sent.";
const MSG_DENIED = "A human refused this call.";
const MSG_EXPIRED = "This approval expired. Nothing was sent.";
const MSG_APPROVAL_GONE = "The approval could not be found. Nothing was sent.";
const MSG_NO_TOOL = "The approved tool no longer exists. Nothing was sent.";
const HOLD_WAIT_MS = 20_000;
const HOLD_POLL_MS = 500;
const MAX_NOTE_CHARS = 200;
const MSG_BLOCKED = "This call is blocked by policy.";
const GHOST_PREFIX = "[GHOST — nothing was sent to the real service]";
const MAX_REASON_CHARS = 200;
const MSG_FAULT_EMPTY = "The service returned a fault.";

type Outcome = TranscriptEntry["outcome"];

/** What one run produced, before it is turned into a transcript entry. */
type RunRecord = {
  result: McpToolResult;
  outcome: Outcome;
  decision: Decision["action"];
  ruleId?: string;
  approvalId?: string;
  args: unknown;
  summary: string;
  soapRequest?: string;
  soapResponse?: string;
};

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A policy block or human refusal: same text, plus a machine-readable marker so clients can tell it from a fault. */
function blockedResult(reason: string): McpToolResult {
  return { content: [{ type: "text", text: reason }], structuredContent: { status: "blocked", reason }, isError: true };
}

/** A check_approval record: no arguments are ever stored on it (`args` is null). */
function checkRecord(
  result: McpToolResult,
  outcome: Outcome,
  decision: Decision["action"],
  summary: string,
  approvalId?: string,
): RunRecord {
  return { result, outcome, decision, args: null, summary, ...(approvalId !== undefined ? { approvalId } : {}) };
}

/** Cuts text to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off while the cut would land inside a multi-byte sequence (continuation bytes are 10xxxxxx).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

/** Text with an optional structured copy; over the 64 KB cap only the truncated text is returned. */
function cappedResult(text: string, data: Record<string, unknown>): McpToolResult {
  if (new TextEncoder().encode(text).length <= MAX_RESULT_BYTES) {
    return { content: [{ type: "text", text }], structuredContent: data };
  }
  const budget = MAX_RESULT_BYTES - new TextEncoder().encode(TRUNCATION_MARKER).length;
  // The structured copy would exceed the cap too, so only the capped text is returned.
  return { content: [{ type: "text", text: truncateUtf8(text, budget) + TRUNCATION_MARKER }] };
}

function successResult(data: Record<string, unknown>): McpToolResult {
  return cappedResult(JSON.stringify(data), data);
}

function ghostResult(sample: unknown): McpToolResult {
  const data: Record<string, unknown> = { ghost: true, result: sample };
  return cappedResult(`${GHOST_PREFIX}\n${JSON.stringify(sample)}`, data);
}

function validationText(issues: { path: PropertyKey[]; message: string }[]): string {
  const parts = issues.map((i) => {
    const path = i.path.length > 0 ? i.path.map(String).join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return truncateUtf8(`Invalid arguments. ${parts.join("; ")}`, MAX_VALIDATION_CHARS);
}

/** Keeps a key part to safe characters and a bounded length so it cannot inject separators. */
function keyPart(value: unknown, fallback: string): string {
  const s = typeof value === "string" ? value.replace(/[^A-Za-z0-9.:-]/g, "_").slice(0, MAX_KEY_PART_CHARS) : "";
  return s === "" ? fallback : s;
}

async function callUpstream(
  deps: Deps,
  op: OperationSchema,
  args: unknown,
): Promise<Pick<RunRecord, "result" | "outcome" | "summary" | "soapRequest" | "soapResponse">> {
  const env = toEnvelope(args, op);
  if (!env.ok) {
    const text =
      env.error.type === "validationError"
        ? validationText(env.error.issues.map((i) => ({ path: [i.path], message: i.message })))
        : "This operation cannot be called live.";
    return { result: errorResult(text), outcome: "error", summary: `${op.name}: request could not be built` };
  }

  const noAnswer = (soapResponse?: string) => ({
    result: errorResult(MSG_NO_ANSWER),
    outcome: "error" as const,
    summary: `${op.name}: no usable answer from the service`,
    soapRequest: env.xml,
    ...(soapResponse !== undefined ? { soapResponse } : {}),
  });

  let res: Awaited<ReturnType<typeof safePost>>;
  try {
    res = await deps.post(op.endpointAddress, {
      body: env.xml,
      headers: env.headers,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
  } catch {
    console.error("pipeline: upstream call threw");
    return noAnswer();
  }
  if (!res.ok) {
    console.error(`pipeline: upstream call failed (${res.error.code})`);
    return noAnswer();
  }

  const parsed = fromEnvelope(res.body, op);
  if (parsed.ok) {
    return {
      result: successResult(parsed.data),
      outcome: "ok",
      summary: `${op.name}: ok`,
      soapRequest: env.xml,
      soapResponse: res.body,
    };
  }
  if (parsed.error.type === "fault") {
    const text = sanitizeText(parsed.error.faultString, MAX_FAULT_CHARS);
    return {
      result: errorResult(text === "" ? MSG_FAULT_EMPTY : text),
      outcome: "fault",
      summary: `${op.name}: the service returned a fault`,
      soapRequest: env.xml,
      soapResponse: res.body,
    };
  }
  console.error(`pipeline: upstream response unreadable (HTTP ${res.status})`);
  return noAnswer(res.body);
}

/** The parts of a RunRecord that the hold and approved-execution paths decide for themselves. */
type Part = Pick<RunRecord, "result" | "outcome" | "summary"> &
  Partial<Pick<RunRecord, "decision" | "ruleId" | "approvalId" | "soapRequest" | "soapResponse">>;

/** Non-error "come back later" result. `status` is "held" (still pending) or "claimed" (another caller is executing it). */
function pendingResult(status: "held" | "claimed", approvalId: string, expiresAt: string): McpToolResult {
  const text =
    status === "held"
      ? `This call is held for human approval. Call check_approval with approvalId "${approvalId}" to collect the result.`
      : `This approved call is already being executed. Call check_approval again later with approvalId "${approvalId}".`;
  const structuredContent: Record<string, unknown> =
    status === "held" ? { status, approvalId, expiresAt } : { status, approvalId };
  return { content: [{ type: "text", text }], structuredContent };
}

/**
 * Runs an approved Approval, using only the arguments stored in it (never caller-supplied ones).
 * Shared by the hold path (approved during the wait) and by `check_approval`.
 *
 * Execute-once, never retry: the claim is atomic, and after any successful claim `markExecuted`
 * is called whether or not the upstream call worked. An approved call is attempted at most once
 * and is never retried automatically; a failed attempt needs a fresh call and a fresh approval.
 *
 * The rules and settings are loaded again and `decide` is re-run with the stored arguments, so a
 * rule changed to `block` (or ghost mode switched on) after approval still wins. A fresh `hold`
 * is not asked again: the human already approved this exact call.
 */
export async function executeApproved(
  deps: Deps,
  input: { service: ServiceDefinition; approval: Approval; tools: ReadonlyMap<string, ToolDef> },
): Promise<Part> {
  const { service, approval, tools } = input;
  const serviceId = service.id ?? "";
  const approvalId = approval.id;

  let claimed: boolean;
  try {
    claimed = await deps.approvals.claimExecution(serviceId, approvalId);
  } catch {
    console.error("pipeline: approval claim failed");
    return {
      result: errorResult(MSG_APPROVAL_STORE),
      outcome: "error",
      approvalId,
      summary: "approved call: approval store unavailable, nothing was sent",
    };
  }
  if (!claimed) {
    return {
      result: pendingResult("claimed", approvalId, approval.expiresAt),
      outcome: "held",
      approvalId,
      summary: "approved call: already claimed, nothing was sent by this call",
    };
  }

  try {
    const tool = tools.get(approval.tool);
    if (!tool) {
      return {
        result: errorResult(MSG_NO_TOOL),
        outcome: "error",
        approvalId,
        summary: "approved call: tool no longer exists, nothing was sent",
      };
    }
    const op = tool.op;

    let rulesRes: Awaited<ReturnType<Registry["getRules"]>>;
    let settingsRes: Awaited<ReturnType<Registry["getSettings"]>>;
    try {
      [rulesRes, settingsRes] = await Promise.all([
        deps.registry.getRules(serviceId),
        deps.registry.getSettings(serviceId),
      ]);
    } catch {
      rulesRes = { ok: false, error: { code: "INTERNAL_ERROR", message: "registry" } };
      settingsRes = rulesRes;
    }
    if (!rulesRes.ok || !settingsRes.ok) {
      return {
        result: errorResult(MSG_UNAVAILABLE),
        outcome: "error",
        approvalId,
        summary: `${op.name}: rules or settings unavailable, nothing was sent`,
      };
    }

    const decision = decide({
      op,
      risk: op.risk,
      args: approval.args,
      rules: rulesRes.value,
      ghost: settingsRes.value.ghost,
    });
    const ruleId = decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {};
    if (decision.action === "block") {
      const reason = sanitizeText(decision.reason, MAX_REASON_CHARS);
      return {
        result: blockedResult(reason === "" ? MSG_BLOCKED : reason),
        outcome: "blocked",
        decision: "block",
        approvalId,
        ...ruleId,
        summary: `${op.name}: blocked by policy after approval, nothing was sent`,
      };
    }
    if (decision.action === "ghost") {
      return {
        result: ghostResult(ghostResponse(op)),
        outcome: "ghost",
        decision: "ghost",
        approvalId,
        ...ruleId,
        summary: `${op.name}: simulated in ghost mode after approval, nothing was sent`,
      };
    }
    // allow or hold: execute with the stored arguments only.
    return { decision: "hold", approvalId, ...ruleId, ...(await callUpstream(deps, op, approval.args)) };
  } finally {
    try {
      await deps.approvals.markExecuted(serviceId, approvalId);
    } catch {
      console.error("pipeline: markExecuted failed");
    }
  }
}

/** Creates the approval, then waits up to 20 s (polling every 500 ms) for a human decision. */
async function holdAndWait(
  deps: Deps,
  ctx: CallContext,
  serviceId: string,
  args: unknown,
  decision: Decision,
): Promise<Part> {
  const { tool } = ctx;
  const op = tool.op;

  let approval: Approval;
  try {
    // Raw parsed args are stored on purpose: they are what gets executed. The UI-facing API redacts.
    approval = await deps.approvals.createApproval(serviceId, {
      serviceId,
      tool: tool.name,
      args,
      risk: op.risk,
      reason: sanitizeText(decision.reason, MAX_REASON_CHARS),
    });
  } catch {
    console.error("pipeline: approval create failed");
    return {
      result: errorResult(MSG_APPROVAL_STORE),
      outcome: "error",
      summary: `${op.name}: approval store unavailable, nothing was sent`,
    };
  }
  const approvalId = approval.id;
  const deadline = deps.now() + HOLD_WAIT_MS;

  for (;;) {
    let current: Approval | null;
    try {
      current = await deps.approvals.getApproval(serviceId, approvalId);
    } catch {
      console.error("pipeline: approval poll failed");
      return {
        result: errorResult(MSG_APPROVAL_STORE),
        outcome: "error",
        approvalId,
        summary: `${op.name}: approval store unavailable while waiting, nothing was sent`,
      };
    }
    if (current === null) {
      return {
        result: errorResult(MSG_APPROVAL_GONE),
        outcome: "error",
        approvalId,
        summary: `${op.name}: approval not found, nothing was sent`,
      };
    }
    switch (current.status) {
      case "approved":
        return executeApproved(deps, { service: ctx.service, approval: current, tools: new Map([[tool.name, tool]]) });
      case "denied": {
        const note = sanitizeText(current.note, MAX_NOTE_CHARS);
        return {
          result: blockedResult(note === "" ? MSG_DENIED : `${MSG_DENIED} ${note}`),
          outcome: "blocked",
          approvalId,
          summary: `${op.name}: refused by a human, nothing was sent`,
        };
      }
      case "expired":
        return {
          result: errorResult(MSG_EXPIRED),
          outcome: "error",
          approvalId,
          summary: `${op.name}: approval expired, nothing was sent`,
        };
      case "executed":
        return {
          result: errorResult(MSG_APPROVAL_GONE),
          outcome: "error",
          approvalId,
          summary: `${op.name}: approval already used, nothing was sent`,
        };
      case "pending":
        break;
    }
    if (deps.now() >= deadline) {
      return {
        result: pendingResult("held", approvalId, approval.expiresAt),
        outcome: "held",
        approvalId,
        summary: `${op.name}: held for approval, nothing was sent yet`,
      };
    }
    await deps.sleep(HOLD_POLL_MS);
  }
}

export function createPipeline(deps: Deps): Pipeline {
  /**
   * Counting order: client IP first, then service. A call refused by the IP limit is not counted
   * against the service total; a call refused by the service limit has already counted for its IP.
   */
  async function checkRate(ctx: { service: ServiceDefinition; clientIp: string }): Promise<"ok" | "limited" | "failed"> {
    const svc = keyPart(ctx.service.id, "unknown");
    const ip = keyPart(ctx.clientIp, "unknown");
    try {
      const byIp = await hit(deps.rateRedis, `rate:ip:${svc}:${ip}`, IP_LIMIT, RATE_WINDOW_SEC);
      if (!byIp.allowed) return "limited";
      const bySvc = await hit(deps.rateRedis, `rate:svc:${svc}`, SERVICE_LIMIT, RATE_WINDOW_SEC);
      return bySvc.allowed ? "ok" : "limited";
    } catch {
      return "failed";
    }
  }

  async function record(
    service: ServiceDefinition,
    started: number,
    toolName: string,
    risk: Risk,
    rec: RunRecord,
  ): Promise<void> {
    try {
      const entry: TranscriptEntry = {
        id: deps.newId(),
        ts: new Date(started).toISOString(),
        tool: toolName,
        args: rec.args,
        risk,
        decision: rec.decision,
        outcome: rec.outcome,
        durationMs: Math.max(0, deps.now() - started),
        summary: rec.summary,
        ...(rec.ruleId !== undefined ? { ruleId: rec.ruleId } : {}),
        ...(rec.approvalId !== undefined ? { approvalId: rec.approvalId } : {}),
        ...(rec.soapRequest !== undefined ? { soapRequest: rec.soapRequest } : {}),
        ...(rec.soapResponse !== undefined ? { soapResponse: rec.soapResponse } : {}),
      };
      await deps.transcripts.appendTranscript(service.id ?? "", entry);
    } catch {
      console.error("pipeline: transcript write failed");
    }
  }

  /** Rate limit, validate the id, load the approval for this service, then act on its status. */
  async function executeCheck(ctx: CheckApprovalContext): Promise<{ rec: RunRecord; risk?: Risk }> {
    const { service } = ctx;

    const limited = await checkRate(ctx);
    if (limited === "limited") {
      return { rec: checkRecord(errorResult(MSG_RATE_LIMITED), "blocked", "block", `${CHECK_TOOL}: rate limited, nothing was sent`) };
    }
    if (limited === "failed") {
      console.error("pipeline: rate limiter unavailable");
      return { rec: checkRecord(errorResult(MSG_RATE_UNAVAILABLE), "error", "block", `${CHECK_TOOL}: rate limiter unavailable, nothing was sent`) };
    }

    const serviceId = service.id;
    const rawId = ctx.approvalId;
    if (
      typeof rawId !== "string" ||
      rawId === "" ||
      rawId.length > MAX_APPROVAL_ID_CHARS ||
      !APPROVAL_ID_PATTERN.test(rawId)
    ) {
      return { rec: checkRecord(errorResult(MSG_BAD_APPROVAL_ID), "error", "block", `${CHECK_TOOL}: invalid approval id, nothing was sent`) };
    }
    if (typeof serviceId !== "string" || serviceId === "") {
      return { rec: checkRecord(errorResult(MSG_UNAVAILABLE), "error", "block", `${CHECK_TOOL}: service has no id, nothing was sent`, rawId) };
    }

    let approval: Approval | null;
    try {
      approval = await deps.approvals.getApproval(serviceId, rawId);
    } catch {
      console.error("pipeline: approval lookup failed");
      return { rec: checkRecord(errorResult(MSG_APPROVAL_STORE), "error", "block", `${CHECK_TOOL}: approval store unavailable, nothing was sent`, rawId) };
    }
    // Approvals are keyed by service; the serviceId comparison is a second guard against cross-service reads.
    if (approval === null || approval.serviceId !== serviceId) {
      return { rec: checkRecord(errorResult(MSG_APPROVAL_NOT_FOUND), "error", "block", `${CHECK_TOOL}: approval not found, nothing was sent`, rawId) };
    }

    const risk = approval.risk;
    switch (approval.status) {
      case "pending":
        return {
          risk,
          rec: checkRecord(
            pendingResult("held", rawId, approval.expiresAt),
            "held",
            "hold",
            `${CHECK_TOOL}: still waiting for a human, nothing was sent`,
            rawId,
          ),
        };
      case "denied": {
        const note = sanitizeText(approval.note, MAX_NOTE_CHARS);
        return {
          risk,
          rec: checkRecord(
            blockedResult(note === "" ? MSG_DENIED : `${MSG_DENIED} ${note}`),
            "blocked",
            "hold",
            `${CHECK_TOOL}: refused by a human, nothing was sent`,
            rawId,
          ),
        };
      }
      case "expired":
        return {
          risk,
          rec: checkRecord(errorResult(MSG_EXPIRED), "error", "hold", `${CHECK_TOOL}: approval expired, nothing was sent`, rawId),
        };
      case "executed":
        return {
          risk,
          rec: checkRecord(
            {
              content: [{ type: "text", text: MSG_ALREADY_EXECUTED }],
              structuredContent: { status: "executed", approvalId: rawId },
            },
            "held",
            "hold",
            `${CHECK_TOOL}: already executed, nothing was sent by this call`,
            rawId,
          ),
        };
      case "approved": {
        const part = await executeApproved(deps, {
          service,
          approval,
          tools: new Map(ctx.tools.map((t) => [t.name, t])),
        });
        return { risk, rec: { decision: "hold", args: null, ...part, approvalId: rawId } };
      }
    }
  }

  async function execute(ctx: CallContext): Promise<RunRecord> {
    const { service, tool } = ctx;
    const op = tool.op;
    const base = { decision: "block" as Decision["action"] };

    // 1. Rate limit, before anything else is read or run. Fails closed on a limiter error.
    const limited = await checkRate(ctx);
    if (limited === "limited") {
      return {
        ...base,
        result: errorResult(MSG_RATE_LIMITED),
        outcome: "blocked",
        args: null,
        summary: `${op.name}: rate limited, nothing was sent`,
      };
    }
    if (limited === "failed") {
      console.error("pipeline: rate limiter unavailable");
      return {
        ...base,
        result: errorResult(MSG_RATE_UNAVAILABLE),
        outcome: "error",
        args: null,
        summary: `${op.name}: rate limiter unavailable, nothing was sent`,
      };
    }

    // 2. Rules and settings. Any failure means nothing runs.
    const serviceId = service.id;
    if (typeof serviceId !== "string" || serviceId === "") {
      return {
        ...base,
        result: errorResult(MSG_UNAVAILABLE),
        outcome: "error",
        args: null,
        summary: `${op.name}: service has no id, nothing was sent`,
      };
    }
    let rulesRes: Awaited<ReturnType<Registry["getRules"]>>;
    let settingsRes: Awaited<ReturnType<Registry["getSettings"]>>;
    try {
      [rulesRes, settingsRes] = await Promise.all([
        deps.registry.getRules(serviceId),
        deps.registry.getSettings(serviceId),
      ]);
    } catch {
      rulesRes = { ok: false, error: { code: "INTERNAL_ERROR", message: "registry" } };
      settingsRes = rulesRes;
    }
    if (!rulesRes.ok || !settingsRes.ok) {
      return {
        ...base,
        result: errorResult(MSG_UNAVAILABLE),
        outcome: "error",
        args: null,
        summary: `${op.name}: rules or settings unavailable, nothing was sent`,
      };
    }

    // 3. Validate. From here on only the parsed value is used.
    const parsed = buildZodSchema(op.inputDescriptor).safeParse(ctx.args);
    if (!parsed.success) {
      const count = parsed.error.issues.length;
      return {
        ...base,
        result: errorResult(validationText(parsed.error.issues)),
        outcome: "error",
        args: null,
        summary: `${op.name}: ${count} invalid argument${count === 1 ? "" : "s"}, nothing was sent`,
      };
    }
    const args: unknown = parsed.data;

    // 4. Decide.
    const decision = decide({
      op,
      risk: op.risk,
      args,
      rules: rulesRes.value,
      ghost: settingsRes.value.ghost,
    });
    const common = {
      decision: decision.action,
      ...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
      args,
    };

    // 5. Act. Exhaustive so a new action is a compile error.
    switch (decision.action) {
      case "block": {
        // The reason is user-authored: it goes to the agent, never into the summary.
        const reason = sanitizeText(decision.reason, MAX_REASON_CHARS);
        return {
          ...common,
          result: blockedResult(reason === "" ? MSG_BLOCKED : reason),
          outcome: "blocked",
          summary: `${op.name}: blocked by policy, nothing was sent`,
        };
      }
      case "ghost":
        return {
          ...common,
          result: ghostResult(ghostResponse(op)),
          outcome: "ghost",
          summary: `${op.name}: simulated in ghost mode, nothing was sent`,
        };
      case "hold":
        return { ...common, ...(await holdAndWait(deps, ctx, serviceId, args, decision)) };
      case "allow":
        return { ...common, ...(await callUpstream(deps, op, args)) };
    }
  }

  return {
    async runCall(ctx) {
      const started = deps.now();
      let rec: RunRecord;
      try {
        rec = await execute(ctx);
      } catch {
        console.error("pipeline: unexpected failure");
        rec = {
          result: errorResult(MSG_INTERNAL),
          outcome: "error",
          decision: "block",
          args: null,
          summary: `${ctx.tool.op.name}: internal error, nothing was sent`,
        };
      }

      // 6. Transcript for every outcome. It can never change or fail the call.
      await record(ctx.service, started, ctx.tool.name, ctx.tool.op.risk, rec);
      return rec.result;
    },

    async runCheckApproval(ctx) {
      const started = deps.now();
      let risk: Risk = "read";
      let rec: RunRecord;
      try {
        const out = await executeCheck(ctx);
        rec = out.rec;
        if (out.risk) risk = out.risk;
      } catch {
        console.error("pipeline: unexpected failure");
        rec = checkRecord(errorResult(MSG_INTERNAL), "error", "block", `${CHECK_TOOL}: internal error, nothing was sent`);
      }
      await record(ctx.service, started, CHECK_TOOL, risk, rec);
      return rec.result;
    },
  };
}
