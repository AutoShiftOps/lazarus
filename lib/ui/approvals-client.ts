import { z } from "zod";

export type ApprovalsErrorKind =
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable";

export type ApprovalsFailure = { ok: false; kind: ApprovalsErrorKind; message: string };

/** Fixed user-facing messages. Server text is never shown. */
export const APPROVAL_MESSAGES: Record<ApprovalsErrorKind, string> = {
  unauthorized: "Only the owner can release calls.",
  not_found: "This call is gone.",
  conflict: "This call was already resolved.",
  rate_limited: "Too many attempts. Wait a moment.",
  unavailable: "The spirits are unreachable. Try again.",
};

export const ApprovalViewSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  risk: z.enum(["read", "write", "destructive"]),
  reason: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired", "executed"]),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type ApprovalItem = z.infer<typeof ApprovalViewSchema>;

const ApprovalListSchema = z.array(ApprovalViewSchema);

export type ListApprovalsResult = { ok: true; approvals: ApprovalItem[] } | ApprovalsFailure;
export type ResolveApprovalResult = { ok: true } | ApprovalsFailure;

export type ApprovalDecision = "approve" | "deny";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  ownerToken?: string | null;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

export interface ResolveOptions extends ClientOptions {
  note?: string;
}

const OWNER_HEADER = "x-lazarus-owner";

function failure(kind: ApprovalsErrorKind): ApprovalsFailure {
  return { ok: false, kind, message: APPROVAL_MESSAGES[kind] };
}

function kindForStatus(status: number): ApprovalsErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

function headers(ownerToken: string | null | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (ownerToken) h[OWNER_HEADER] = ownerToken;
  return h;
}

function approvalsUrl(serviceId: string, approvalId?: string): string {
  const base = `/api/services/${encodeURIComponent(serviceId)}/approvals`;
  return approvalId === undefined ? base : `${base}/${encodeURIComponent(approvalId)}`;
}

export async function listApprovals(
  serviceId: string,
  options: ClientOptions = {},
): Promise<ListApprovalsResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(approvalsUrl(serviceId), {
      method: "GET",
      headers: headers(options.ownerToken, false),
      signal: options.signal,
      cache: "no-store",
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    const parsed = ApprovalListSchema.safeParse(await res.json());
    if (!parsed.success) return failure("unavailable");
    return { ok: true, approvals: parsed.data };
  } catch {
    return failure("unavailable");
  }
}

export async function resolveApproval(
  serviceId: string,
  approvalId: string,
  decision: ApprovalDecision,
  options: ResolveOptions = {},
): Promise<ResolveApprovalResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const body: { decision: ApprovalDecision; note?: string } = { decision };
  if (options.note !== undefined && options.note !== "") body.note = options.note;
  try {
    const res = await doFetch(approvalsUrl(serviceId, approvalId), {
      method: "POST",
      headers: headers(options.ownerToken, true),
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!res.ok) return failure(kindForStatus(res.status));
    return { ok: true };
  } catch {
    return failure("unavailable");
  }
}
