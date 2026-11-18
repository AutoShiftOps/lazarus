// lib/mcp/pipeline.ts
// The call pipeline (Requirements 3 and 8): decide what happens to one tools/call and record it.
// Everything is injected through Deps: no Redis client, env or global state is imported here.
//
// Step order:
//   1 rate limit (IP, then service; fails closed) -> 2 rules + settings (fail closed) -> 3 validate -> 4 decide -> 5 act -> 6 transcript (always).
// Upstream traffic only ever happens in the `allow` branch of step 5.

import { hit, type RateRedis } from "../rate-limit";
import type { Approvals } from "../safety/approvals";
import { decide } from "../safety/policy";
import type { Registry } from "../registry";
import { ghostResponse } from "../safety/ghost";
import type { Transcripts } from "../safety/transcript";
import type { Decision, TranscriptEntry } from "../safety/types";
import type { safePost } from "../soap/fetcher";
import { buildZodSchema } from "../soap/schema-generator";
import { fromEnvelope, toEnvelope } from "../soap/translator";
import type { ServiceDefinition } from "../soap/types";
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
  newId: () => string;
};

export type CallContext = {
  service: ServiceDefinition;
  tool: ToolDef;
  args: unknown;
  clientIp: string;
};

export interface Pipeline {
  runCall(ctx: CallContext): Promise<McpToolResult>;
}

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
const MSG_NO_APPROVAL = "Approval flow is not available.";
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
  args: unknown;
  summary: string;
  soapRequest?: string;
  soapResponse?: string;
};

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
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

export function createPipeline(deps: Deps): Pipeline {
  /**
   * Counting order: client IP first, then service. A call refused by the IP limit is not counted
   * against the service total; a call refused by the service limit has already counted for its IP.
   */
  async function checkRate(ctx: CallContext): Promise<"ok" | "limited" | "failed"> {
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
          result: errorResult(reason === "" ? MSG_BLOCKED : reason),
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
        // Placeholder until task 9.2.
        return { ...common, result: errorResult(MSG_NO_APPROVAL), outcome: "held", summary: `${op.name}: held, approval flow not available` };
      case "allow":
        return { ...common, ...(await callUpstream(ctx, args)) };
    }
  }

  async function callUpstream(
    ctx: CallContext,
    args: unknown,
  ): Promise<Pick<RunRecord, "result" | "outcome" | "summary" | "soapRequest" | "soapResponse">> {
    const op = ctx.tool.op;
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
      try {
        const entry: TranscriptEntry = {
          id: deps.newId(),
          ts: new Date(started).toISOString(),
          tool: ctx.tool.name,
          args: rec.args,
          risk: ctx.tool.op.risk,
          decision: rec.decision,
          outcome: rec.outcome,
          durationMs: Math.max(0, deps.now() - started),
          summary: rec.summary,
          ...(rec.ruleId !== undefined ? { ruleId: rec.ruleId } : {}),
          ...(rec.soapRequest !== undefined ? { soapRequest: rec.soapRequest } : {}),
          ...(rec.soapResponse !== undefined ? { soapResponse: rec.soapResponse } : {}),
        };
        await deps.transcripts.appendTranscript(ctx.service.id ?? "", entry);
      } catch {
        console.error("pipeline: transcript write failed");
      }
      return rec.result;
    },
  };
}
