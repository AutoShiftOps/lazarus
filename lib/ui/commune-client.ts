// lib/ui/commune-client.ts
// Calls /api/mcp/{id} with a JSON-RPC tools/call, exactly as an agent would (same headers as
// e2e/mcp-gateway.spec.ts, stateless: no initialize). Result shapes mirror lib/mcp/pipeline.ts.
// Nothing here bypasses rate limits, rules, ghost mode or approvals.

import { z } from "zod";

export type CommuneResult =
  | { kind: "ok"; data: unknown }
  | { kind: "held"; approvalId: string; expiresAt: string }
  | { kind: "blocked"; message: string }
  | { kind: "ghost"; data: unknown }
  | { kind: "fault"; message: string }
  | { kind: "rate_limited" }
  | { kind: "unavailable" };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CommuneOptions {
  signal?: AbortSignal;
  fetch?: FetchLike;
}

/** Fixed user-facing messages for transport-level problems. Server text is never shown for these. */
export const COMMUNE_MESSAGES = {
  rate_limited: "Too many calls. Wait a moment and try again.",
  unavailable: "The spirits are unreachable. Try again.",
  too_large: "This request is too large to send.",
  not_found: "This service could not be found.",
  rpc_error: "The spirits could not process this call.",
  malformed: "The spirits answered in a way Lazarus could not read.",
  already_collected: "This call was already collected.",
  blocked_default: "This call is blocked by policy.",
} as const;

const CHECK_APPROVAL_TOOL = "check_approval";
/** Fixed texts produced by pipeline.ts that identify a result kind (isError results carry no other marker). */
const PIPELINE_RATE_LIMITED = "Too many calls";
const PIPELINE_RATE_UNAVAILABLE_PREFIX = "Rate limiting is unavailable";
const PIPELINE_BLOCKED_TEXT = "This call is blocked by policy.";
const PIPELINE_DENIED_PREFIX = "A human refused this call.";
/** ghostResult text prefix; only the text carries it when the structured copy was dropped for size. */
const GHOST_PREFIX = "[GHOST";
const MAX_MESSAGE_CHARS = 500;

let nextRpcId = 1;

const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const RpcSchema = z.object({
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

function mcpUrl(serviceId: string): string {
  return `/api/mcp/${encodeURIComponent(serviceId)}`;
}

function textOf(content: { type: string; text?: string }[] | undefined): string {
  const first = content?.find((c) => c.type === "text" && typeof c.text === "string");
  return first?.text ?? "";
}

function cap(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function mapToolResult(raw: unknown): CommuneResult {
  const parsed = ToolResultSchema.safeParse(raw);
  if (!parsed.success) return { kind: "fault", message: COMMUNE_MESSAGES.malformed };
  const { structuredContent, isError, content } = parsed.data;
  const text = textOf(content);

  if (isError === true) {
    if (text === PIPELINE_RATE_LIMITED) return { kind: "rate_limited" };
    if (text.startsWith(PIPELINE_RATE_UNAVAILABLE_PREFIX)) return { kind: "unavailable" };
    if (text === PIPELINE_BLOCKED_TEXT || text.startsWith(PIPELINE_DENIED_PREFIX)) {
      return { kind: "blocked", message: cap(text) };
    }
    // Rule reasons, SOAP faults and validation errors all arrive as plain isError text with no marker.
    return { kind: "fault", message: text === "" ? COMMUNE_MESSAGES.malformed : cap(text) };
  }

  if (structuredContent !== undefined) {
    const status = structuredContent.status;
    if (status === "held" && typeof structuredContent.approvalId === "string") {
      const expiresAt = typeof structuredContent.expiresAt === "string" ? structuredContent.expiresAt : "";
      return { kind: "held", approvalId: structuredContent.approvalId, expiresAt };
    }
    if (status === "claimed" && typeof structuredContent.approvalId === "string") {
      return { kind: "held", approvalId: structuredContent.approvalId, expiresAt: "" };
    }
    if (status === "executed" && typeof structuredContent.approvalId === "string") {
      return { kind: "fault", message: COMMUNE_MESSAGES.already_collected };
    }
    if (structuredContent.ghost === true) return { kind: "ghost", data: structuredContent.result };
    return { kind: "ok", data: structuredContent };
  }

  if (text.startsWith(GHOST_PREFIX)) {
    // Oversized ghost result: the structured copy was dropped, only truncated text remains.
    const newline = text.indexOf("\n");
    return { kind: "ghost", data: newline === -1 ? "" : text.slice(newline + 1) };
  }
  return { kind: "ok", data: text };
}

async function rpcToolCall(
  serviceId: string,
  name: string,
  args: unknown,
  options: CommuneOptions,
): Promise<CommuneResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(mcpUrl(serviceId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextRpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: options.signal,
      cache: "no-store",
    });
  } catch (error) {
    // An abort is the caller's decision, not a failure to report.
    if (options.signal?.aborted) throw error;
    return { kind: "unavailable" };
  }

  if (res.status === 429) return { kind: "rate_limited" };
  if (res.status === 503) return { kind: "unavailable" };
  if (res.status === 413) return { kind: "fault", message: COMMUNE_MESSAGES.too_large };
  if (res.status === 404) return { kind: "fault", message: COMMUNE_MESSAGES.not_found };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return res.ok ? { kind: "fault", message: COMMUNE_MESSAGES.malformed } : { kind: "unavailable" };
  }
  if (!res.ok) return { kind: "unavailable" };

  const rpc = RpcSchema.safeParse(body);
  if (!rpc.success) return { kind: "fault", message: COMMUNE_MESSAGES.malformed };
  if (rpc.data.error !== undefined) return { kind: "fault", message: COMMUNE_MESSAGES.rpc_error };
  if (rpc.data.result === undefined) return { kind: "fault", message: COMMUNE_MESSAGES.malformed };
  return mapToolResult(rpc.data.result);
}

/**
 * Calls one tool. Rejects with the abort error when `signal` aborts; every other failure is a
 * typed result.
 */
export function callTool(
  serviceId: string,
  toolName: string,
  args: unknown,
  options: CommuneOptions = {},
): Promise<CommuneResult> {
  return rpcToolCall(serviceId, toolName, args, options);
}

/** Collects the outcome of a held call through the built-in check_approval tool. */
export function collectResult(
  serviceId: string,
  approvalId: string,
  options: CommuneOptions = {},
): Promise<CommuneResult> {
  return rpcToolCall(serviceId, CHECK_APPROVAL_TOOL, { approvalId }, options);
}
