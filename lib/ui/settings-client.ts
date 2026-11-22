import { z } from "zod";

export type SettingsErrorKind = "unauthorized" | "not_found" | "invalid" | "rate_limited" | "unavailable";

export type SettingsFailure = { ok: false; kind: SettingsErrorKind; message: string };

/** Fixed user-facing messages. Server text is never shown. */
export const SETTINGS_MESSAGES: Record<SettingsErrorKind, string> = {
  unauthorized: "Only the owner can change this.",
  not_found: "This spirit has passed on.",
  invalid: "That change was not accepted.",
  rate_limited: "Too many attempts. Wait a moment.",
  unavailable: "The spirits are unreachable. Try again.",
};

const GhostSchema = z.object({ ghost: z.boolean() });

export type SettingsResult = { ok: true; ghost: boolean } | SettingsFailure;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SettingsClientOptions {
  ownerToken?: string | null;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

const OWNER_HEADER = "x-lazarus-owner";

function failure(kind: SettingsErrorKind): SettingsFailure {
  return { ok: false, kind, message: SETTINGS_MESSAGES[kind] };
}

function kindForStatus(status: number): SettingsErrorKind {
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

/** Reads the ghost setting from the public service summary (GET /api/services/[id]). */
export async function getSettings(serviceId: string, options: SettingsClientOptions = {}): Promise<SettingsResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`/api/services/${encodeURIComponent(serviceId)}`, {
      method: "GET",
      headers: headers(options.ownerToken, false),
      signal: options.signal,
      cache: "no-store",
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = GhostSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, ghost: parsed.data.ghost };
  } catch {
    return failure("unavailable");
  }
}

/** Sets ghost mode (PATCH /api/services/[id]/settings). Returns the saved value. */
export async function patchSettings(
  serviceId: string,
  ghost: boolean,
  options: SettingsClientOptions = {},
): Promise<SettingsResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`/api/services/${encodeURIComponent(serviceId)}/settings`, {
      method: "PATCH",
      headers: headers(options.ownerToken, true),
      body: JSON.stringify({ ghost }),
      signal: options.signal,
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = GhostSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, ghost: parsed.data.ghost };
  } catch {
    return failure("unavailable");
  }
}
