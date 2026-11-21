import { z } from "zod";

export type TranscriptsErrorKind = "unauthorized" | "not_found" | "rate_limited" | "unavailable";

export type TranscriptsFailure = { ok: false; kind: TranscriptsErrorKind; message: string };

/** Fixed user-facing messages. Server text is never shown. */
export const TRANSCRIPT_MESSAGES: Record<TranscriptsErrorKind, string> = {
  unauthorized: "Only the owner can read this transcript.",
  not_found: "This spirit has passed on.",
  rate_limited: "Too many attempts. Wait a moment.",
  unavailable: "The spirits are unreachable. Try again.",
};

export const TranscriptViewSchema = z.object({
  id: z.string(),
  ts: z.string(),
  tool: z.string(),
  args: z.unknown(),
  risk: z.enum(["read", "write", "destructive"]),
  decision: z.enum(["allow", "hold", "block", "ghost"]),
  ruleId: z.string().optional(),
  approvalId: z.string().optional(),
  outcome: z.enum(["ok", "fault", "error", "held", "blocked", "ghost"]),
  durationMs: z.number(),
  soapRequest: z.string().optional(),
  soapResponse: z.string().optional(),
  summary: z.string(),
});

export type TranscriptItem = z.infer<typeof TranscriptViewSchema>;

const TranscriptListSchema = z.array(TranscriptViewSchema);

export type ListTranscriptsResult = { ok: true; entries: TranscriptItem[] } | TranscriptsFailure;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TranscriptsClientOptions {
  ownerToken?: string | null;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

const OWNER_HEADER = "x-lazarus-owner";

function failure(kind: TranscriptsErrorKind): TranscriptsFailure {
  return { ok: false, kind, message: TRANSCRIPT_MESSAGES[kind] };
}

function kindForStatus(status: number): TranscriptsErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export async function listTranscripts(
  serviceId: string,
  options: TranscriptsClientOptions = {},
): Promise<ListTranscriptsResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = {};
  if (options.ownerToken) headers[OWNER_HEADER] = options.ownerToken;
  try {
    const res = await doFetch(`/api/services/${encodeURIComponent(serviceId)}/transcripts`, {
      method: "GET",
      headers,
      signal: options.signal,
      cache: "no-store",
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = TranscriptListSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, entries: parsed.data };
  } catch {
    return failure("unavailable");
  }
}
