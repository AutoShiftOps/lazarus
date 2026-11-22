import { z } from "zod";
import { RuleSetSchema } from "../safety/schemas";
import type { Rule } from "../safety/types";

export type RulesErrorKind = "unauthorized" | "not_found" | "invalid" | "rate_limited" | "unavailable";

export type RulesFailure = { ok: false; kind: RulesErrorKind; message: string };

/** Fixed user-facing messages. Server text is never shown. */
export const RULES_MESSAGES: Record<RulesErrorKind, string> = {
  unauthorized: "Only the owner can change rules.",
  not_found: "This spirit has passed on.",
  invalid: "The rules were not accepted.",
  rate_limited: "Too many attempts. Wait a moment.",
  unavailable: "The spirits are unreachable. Try again.",
};

const SummaryRulesSchema = z.object({ rules: RuleSetSchema });

export type RulesResult = { ok: true; rules: Rule[] } | RulesFailure;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RulesClientOptions {
  ownerToken?: string | null;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

const OWNER_HEADER = "x-lazarus-owner";

function failure(kind: RulesErrorKind): RulesFailure {
  return { ok: false, kind, message: RULES_MESSAGES[kind] };
}

function kindForStatus(status: number): RulesErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413) return "invalid";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

function headers(ownerToken: string | null | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (ownerToken) h[OWNER_HEADER] = ownerToken;
  return h;
}

/** Reads the rules from the public service summary (GET /api/services/[id]). */
export async function getRules(serviceId: string, options: RulesClientOptions = {}): Promise<RulesResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`/api/services/${encodeURIComponent(serviceId)}`, {
      method: "GET",
      headers: headers(options.ownerToken, false),
      signal: options.signal,
      cache: "no-store",
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = SummaryRulesSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, rules: parsed.data.rules };
  } catch {
    return failure("unavailable");
  }
}

/** Replaces all rules (PUT /api/services/[id]/rules). Returns the saved list. */
export async function putRules(
  serviceId: string,
  rules: Rule[],
  options: RulesClientOptions = {},
): Promise<RulesResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`/api/services/${encodeURIComponent(serviceId)}/rules`, {
      method: "PUT",
      headers: headers(options.ownerToken, true),
      body: JSON.stringify(rules),
      signal: options.signal,
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = RuleSetSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, rules: parsed.data };
  } catch {
    return failure("unavailable");
  }
}
