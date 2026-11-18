// lib/api/services.ts
// Logic for the management routes under /api/services/[id]. Route files stay thin and call this.
// Every error body is { error, code } with fixed text; no Redis, registry or token text ever reaches a client.

import { z } from "zod";
import { authorizeOwner, isDemoService } from "../auth/owner";
import { sanitizeText } from "../mcp/tools";
import { publicDefinition } from "../owner-token";
import { hit, type RateRedis } from "../rate-limit";
import { isServiceId, type Registry } from "../registry";
import type { Approvals } from "../safety/approvals";
import { redactJson, redactXml } from "../safety/redact";
import type { RuleSetInput } from "../safety/schemas";
import type { Transcripts } from "../safety/transcript";
import type { Approval, TranscriptEntry } from "../safety/types";
import type { Risk, ServiceDefinition } from "../soap/types";

export type ApiErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "INVALID_REQUEST"
  | "TOO_LARGE"
  | "CONFLICT"
  | "RATE_LIMITED";

export const OWNER_HEADER = "x-lazarus-owner";
export const MAX_JSON_BODY_BYTES = 256 * 1024;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const NO_STORE = { "cache-control": "no-store" } as const;

/** True when `id` has the shape of an approval id. Does not touch Redis. */
export function isApprovalId(id: string): boolean {
  return APPROVAL_ID_RE.test(id);
}

export function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function jsonError(status: number, code: ApiErrorCode, error: string): Response {
  return jsonResponse(status, { error, code });
}

export const notFound = (): Response => jsonError(404, "NOT_FOUND", "Service not found.");
/** The one response for every storage failure (throw or ok:false). */
export const unavailable = (): Response => jsonError(503, "UNAVAILABLE", "The registry is temporarily unavailable.");
/** Same body for a missing, malformed or wrong owner token. */
export const unauthorized = (): Response => jsonError(401, "UNAUTHORIZED", "Owner token required.");

/**
 * Runs `fn` and maps any throw to the fixed 503. Handlers wrap their storage work in this so no
 * upstream message can escape.
 */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch {
    console.error("services api: storage failure");
    return unavailable();
  }
}

type ServiceLookup =
  | { ok: true; service: ServiceDefinition }
  | { ok: false; response: Response };

/** Validates the id first (no registry call for a bad id), then loads the service. */
export async function loadService(registry: Pick<Registry, "getService">, id: string): Promise<ServiceLookup> {
  if (!isServiceId(id)) return { ok: false, response: notFound() };
  const found = await registry.getService(id);
  if (!found.ok) return { ok: false, response: unavailable() };
  if (found.value === null) return { ok: false, response: notFound() };
  return { ok: true, service: found.value };
}

/** Returns a 401 Response unless the request carries this service's owner token; null means authorised. */
export async function requireOwner(service: ServiceDefinition, request: Request): Promise<Response | null> {
  const ok = await authorizeOwner(service, request.headers.get(OWNER_HEADER));
  return ok ? null : unauthorized();
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Reads a JSON body with a byte cap. Never echoes the body or parser text back. */
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<BodyResult> {
  const raw = request.headers.get("content-length");
  if (raw !== null && /^\d+$/.test(raw.trim()) && Number(raw.trim()) > maxBytes) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) return tooLarge();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_REQUEST", "The request body is not valid JSON.") };
  }
}

function tooLarge(): { ok: false; response: Response } {
  return { ok: false, response: jsonError(413, "TOO_LARGE", "Request body is too large.") };
}

// ─── PUT rules / PATCH settings ──────────────────────────────────────────────

export const MAX_RULES_BODY_BYTES = 32 * 1024;
export const MAX_SETTINGS_BODY_BYTES = 4 * 1024;

export type WriteDeps = {
  registry: Pick<Registry, "getService" | "getRules" | "putRules" | "getSettings" | "putSettings">;
};

type PutOutcome = { ok: true } | { ok: false; error: { code: string; message: string } };

/**
 * Shared flow: id -> service lookup -> owner auth -> bounded body -> save. A registry INVALID_REQUEST
 * becomes 400 with its (already capped) field-error message; any other failure becomes the fixed 503.
 */
async function writeOwned(
  deps: WriteDeps,
  id: string,
  request: Request,
  maxBytes: number,
  save: (body: unknown) => Promise<PutOutcome>,
  readBack: () => Promise<{ ok: true; value: unknown } | { ok: false }>,
): Promise<Response> {
  return guarded(async () => {
    const loaded = await loadService(deps.registry, id);
    if (!loaded.ok) return loaded.response;
    const denied = await requireOwner(loaded.service, request);
    if (denied) return denied;
    const body = await readJsonBody(request, maxBytes);
    if (!body.ok) return body.response;
    const saved = await save(body.value);
    if (!saved.ok) {
      if (saved.error.code === "INVALID_REQUEST") {
        return jsonError(400, "INVALID_REQUEST", saved.error.message.slice(0, 500));
      }
      return unavailable();
    }
    const back = await readBack();
    if (!back.ok) return unavailable();
    return jsonResponse(200, back.value);
  });
}

/** PUT /api/services/[id]/rules: replaces the rules with the bare JSON array in the body. */
export function putServiceRules(deps: WriteDeps, id: string, request: Request): Promise<Response> {
  return writeOwned(
    deps,
    id,
    request,
    MAX_RULES_BODY_BYTES,
    (body) => deps.registry.putRules(id, body),
    () => deps.registry.getRules(id),
  );
}

/** PATCH /api/services/[id]/settings: body is exactly { ghost: boolean }. */
export function patchServiceSettings(deps: WriteDeps, id: string, request: Request): Promise<Response> {
  return writeOwned(
    deps,
    id,
    request,
    MAX_SETTINGS_BODY_BYTES,
    (body) => deps.registry.putSettings(id, body),
    () => deps.registry.getSettings(id),
  );
}

// ─── GET /api/services/[id] ──────────────────────────────────────────────────

export type OperationSummary = {
  name: string;
  port: string;
  risk: Risk;
  riskReason: string;
  riskSource: "heuristic" | "model";
};

export type ServiceSummary = {
  id: string;
  name: string;
  ghost: boolean;
  isDemo: boolean;
  rules: RuleSetInput;
  operations: OperationSummary[];
};

export type SummaryDeps = {
  registry: Pick<Registry, "getService" | "getRules" | "getSettings">;
};

/** Public summary of a service. Built field by field from the public definition; never carries the owner hash. */
export async function getServiceSummary(deps: SummaryDeps, id: string): Promise<Response> {
  try {
    const loaded = await loadService(deps.registry, id);
    if (!loaded.ok) return loaded.response;
    const [rules, settings] = await Promise.all([deps.registry.getRules(id), deps.registry.getSettings(id)]);
    if (!rules.ok || !settings.ok) return unavailable();

    const pub = publicDefinition(loaded.service);
    const summary: ServiceSummary = {
      id,
      name: pub.name,
      ghost: settings.value.ghost,
      isDemo: isDemoService(loaded.service),
      rules: rules.value,
      operations: pub.ports.flatMap((p) =>
        p.operations.map((o) => ({
          name: o.name,
          port: p.name,
          risk: o.risk,
          riskReason: o.riskReason,
          riskSource: o.riskSource,
        })),
      ),
    };
    return jsonResponse(200, summary);
  } catch {
    console.error("services api: summary failed");
    return unavailable();
  }
}

// ─── GET approvals / POST approvals/[aid] ────────────────────────────────────

export const MAX_APPROVAL_BODY_BYTES = 4 * 1024;
export const MAX_NOTE_CHARS = 200;
export const RESOLVE_LIMIT_PER_MIN = 30;
const RESOLVE_WINDOW_SEC = 60;
const MAX_IP_KEY_CHARS = 64;

export type ApprovalsDeps = {
  registry: Pick<Registry, "getService">;
  approvals: Pick<Approvals, "listApprovals" | "getApproval" | "resolveApproval">;
  rateRedis: RateRedis;
};

const ResolveBodySchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  })
  .strict();

/** An approval as the API shows it: the stored arguments are replaced by their redacted copy. */
export type ApprovalView = Omit<Approval, "args"> & { args: unknown };

function toView(a: Approval): ApprovalView {
  return { ...a, args: redactJson(a.args) };
}

/** First x-forwarded-for entry, else x-real-ip, else "unknown"; reduced to safe characters and a bounded length. */
export function clientIpOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = forwarded ? forwarded : (request.headers.get("x-real-ip")?.trim() ?? "");
  const safe = raw.replace(/[^A-Za-z0-9.:-]/g, "_").slice(0, MAX_IP_KEY_CHARS);
  return safe === "" ? "unknown" : safe;
}

/** Demo services are public; every other service needs the owner token. Null means allowed. */
async function requireOwnerUnlessDemo(service: ServiceDefinition, request: Request): Promise<Response | null> {
  if (isDemoService(service)) return null;
  return requireOwner(service, request);
}

/** GET /api/services/[id]/approvals: newest first, at most 50, arguments redacted. */
export function listServiceApprovals(deps: ApprovalsDeps, id: string, request: Request): Promise<Response> {
  return guarded(async () => {
    const loaded = await loadService(deps.registry, id);
    if (!loaded.ok) return loaded.response;
    const denied = await requireOwnerUnlessDemo(loaded.service, request);
    if (denied) return denied;
    const list = await deps.approvals.listApprovals(id);
    return jsonResponse(200, list.slice(0, 50).map(toView));
  });
}

/**
 * POST /api/services/[id]/approvals/[aid]. Order: ids (404, no storage) -> service lookup (404/503)
 * -> owner token unless demo (401) -> rate limit (429; a limiter failure is 503) -> body (413/400)
 * -> resolve (404/409/503).
 */
export function resolveServiceApproval(
  deps: ApprovalsDeps,
  id: string,
  aid: string,
  request: Request,
): Promise<Response> {
  return guarded(async () => {
    if (!isServiceId(id)) return notFound();
    if (!isApprovalId(aid)) return jsonError(404, "NOT_FOUND", "Approval not found.");
    const loaded = await loadService(deps.registry, id);
    if (!loaded.ok) return loaded.response;
    const denied = await requireOwnerUnlessDemo(loaded.service, request);
    if (denied) return denied;

    const limit = await hit(
      deps.rateRedis,
      `rate:approve:${id}:${clientIpOf(request)}`,
      RESOLVE_LIMIT_PER_MIN,
      RESOLVE_WINDOW_SEC,
    );
    if (!limit.allowed) {
      return Response.json(
        { error: "Too many requests. Try again shortly.", code: "RATE_LIMITED" },
        { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfter) } },
      );
    }

    const body = await readJsonBody(request, MAX_APPROVAL_BODY_BYTES);
    if (!body.ok) return body.response;
    const parsed = ResolveBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return jsonError(400, "INVALID_REQUEST", 'Body must be { decision: "approve" | "deny", note?: string (max 200) }.');
    }
    const note = parsed.data.note === undefined ? "" : sanitizeText(parsed.data.note, MAX_NOTE_CHARS);

    const result = await deps.approvals.resolveApproval(
      id,
      aid,
      parsed.data.decision,
      note === "" ? undefined : note,
    );
    if (result === "not_found") return jsonError(404, "NOT_FOUND", "Approval not found.");
    if (result === "conflict") return jsonError(409, "CONFLICT", "This approval is no longer pending.");

    const updated = await deps.approvals.getApproval(id, aid);
    if (!updated) return unavailable();
    return jsonResponse(200, toView(updated));
  });
}

// ─── GET transcripts ─────────────────────────────────────────────────────────

export const TRANSCRIPT_LIMIT = 100;
const MAX_SINCE_CHARS = 64;
/** Calendar date, optionally with a time and zone. Rejects the lenient forms Date.parse would accept ("1", "2020", "May 5"). */
const SINCE_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

export type TranscriptsDeps = {
  registry: Pick<Registry, "getService">;
  transcripts: Pick<Transcripts, "listTranscripts">;
};

/** Returns the normalised ISO string, or null when `raw` is not a valid ISO date. */
function parseSince(raw: string): string | null {
  if (raw.length > MAX_SINCE_CHARS || !SINCE_RE.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Redacts again on the way out, whatever the store returned. */
function redactEntry(e: TranscriptEntry): TranscriptEntry {
  const out: TranscriptEntry = { ...e, args: redactJson(e.args) };
  if (typeof e.soapRequest === "string") out.soapRequest = redactXml(e.soapRequest);
  if (typeof e.soapResponse === "string") out.soapResponse = redactXml(e.soapResponse);
  return out;
}

/**
 * GET /api/services/[id]/transcripts?since=<ISO>. Order: id (404, no storage) -> service lookup (404/503)
 * -> owner token unless demo (401) -> `since` (400) -> list. Newest first, at most 100. `since` is
 * exclusive: only entries strictly newer than it are returned.
 */
export function listServiceTranscripts(deps: TranscriptsDeps, id: string, request: Request): Promise<Response> {
  return guarded(async () => {
    const loaded = await loadService(deps.registry, id);
    if (!loaded.ok) return loaded.response;
    const denied = await requireOwnerUnlessDemo(loaded.service, request);
    if (denied) return denied;

    const rawSince = new URL(request.url).searchParams.get("since");
    let since: string | undefined;
    if (rawSince !== null) {
      const parsed = parseSince(rawSince);
      if (parsed === null) return jsonError(400, "INVALID_REQUEST", "since must be an ISO 8601 date.");
      since = parsed;
    }

    const list = await deps.transcripts.listTranscripts(id, since);
    return jsonResponse(200, list.slice(0, TRANSCRIPT_LIMIT).map(redactEntry));
  });
}
