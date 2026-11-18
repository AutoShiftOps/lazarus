// lib/safety/approvals.ts
// Redis-backed approvals. No Redis or env access at import time: the caller injects the client.
//
// Hash layout at `approval:{svc}:{id}` (TTL 900 s):
//   data          JSON of the immutable Approval fields (raw args, needed to execute; never log)
//   status        pending | approved | denied | executed
//   expiresAtMs   epoch ms, read by the Lua scripts
//   resolvedAt?   ISO timestamp, set by resolve
//   note?         free text, set by resolve
//   claimed       set by the claim script (HSETNX) for the first caller only
// "expired" is derived on read: a pending approval past expiresAt.

import { nanoid } from "nanoid";
import type { Approval, ApprovalStatus } from "./types";

const APPROVAL_TTL_SECONDS = 900;
const LIST_TTL_SECONDS = 2_592_000; // 30 days
const LIST_MAX = 50;
const STORE_ERROR_MESSAGE = "Approval store unavailable.";

/** Minimal Redis surface used by approvals (matches the @upstash/redis client methods). */
export interface ApprovalsRedis {
  hset(key: string, fields: Record<string, string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  lpush(key: string, ...elements: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
}

/**
 * Compare-and-set. KEYS[1]=hash. ARGV: new status, now (ms), resolvedAt, note.
 * Returns "ok", "not_found" or "conflict". Changes status only when it is
 * "pending" and the approval has not expired.
 * tests/helpers/fake-approvals-redis.ts mirrors this logic in JS.
 */
export const RESOLVE_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'status')
if not st then return 'not_found' end
if st ~= 'pending' then return 'conflict' end
local exp = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if (not exp) or tonumber(ARGV[2]) >= exp then return 'conflict' end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'resolvedAt', ARGV[3], 'note', ARGV[4])
return 'ok'
`;

/**
 * Claim. KEYS[1]=hash. ARGV: now (ms). Returns 1 only for the first caller and
 * only while status is "approved" and not expired (the status check and the
 * HSETNX run in one script, so a concurrent deny cannot interleave).
 * The fake mirrors this logic in JS.
 */
export const CLAIM_SCRIPT = `
local st = redis.call('HGET', KEYS[1], 'status')
if st ~= 'approved' then return 0 end
local exp = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if (not exp) or tonumber(ARGV[1]) >= exp then return 0 end
return redis.call('HSETNX', KEYS[1], 'claimed', '1')
`;

/** Mark executed, only when the hash still exists (never recreates an expired key). The fake mirrors this. */
export const MARK_EXECUTED_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', 'executed')
return 1
`;

export type ResolveResult = "ok" | "not_found" | "conflict";

export type NewApproval = Omit<Approval, "id" | "status" | "createdAt" | "expiresAt">;

export interface Approvals {
  createApproval(svc: string, a: NewApproval): Promise<Approval>;
  /** Applies expiry: a pending approval past expiresAt reads as "expired". */
  getApproval(svc: string, id: string): Promise<Approval | null>;
  resolveApproval(
    svc: string,
    id: string,
    d: "approve" | "deny",
    note?: string,
  ): Promise<ResolveResult>;
  /** True only for the first caller, and only when the approval is approved and unexpired. */
  claimExecution(svc: string, id: string): Promise<boolean>;
  markExecuted(svc: string, id: string): Promise<void>;
  listApprovals(svc: string): Promise<Approval[]>;
}

const approvalKey = (svc: string, id: string): string => `approval:${svc}:${id}`;
const listKey = (svc: string): string => `approvals:${svc}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATUSES: readonly string[] = ["pending", "approved", "denied", "executed"];

/** Rebuilds an Approval from a stored hash; tolerant of client-side JSON deserialization. */
function fromHash(h: Record<string, unknown>, nowMs: number): Approval | null {
  let data: unknown = h.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const status = typeof h.status === "string" ? h.status : "";
  if (!isRecord(data) || !STATUSES.includes(status)) return null;
  const expiresAtMs = Number(h.expiresAtMs);
  let effective = status as ApprovalStatus;
  if (effective === "pending" && Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
    effective = "expired";
  }
  const approval = { ...(data as unknown as Approval), status: effective };
  if (typeof h.resolvedAt === "string" && h.resolvedAt !== "") {
    approval.resolvedAt = h.resolvedAt;
  }
  if (h.note !== undefined && h.note !== null && String(h.note) !== "") {
    approval.note = String(h.note);
  }
  return approval;
}

export function createApprovals(
  redis: ApprovalsRedis,
  options: { now?: () => number } = {},
): Approvals {
  const now = options.now ?? (() => Date.now());

  /** Any Redis failure becomes one fixed-message Error; upstream text is dropped. */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new Error(STORE_ERROR_MESSAGE);
    }
  }

  async function read(svc: string, id: string): Promise<Approval | null> {
    const h = await redis.hgetall(approvalKey(svc, id));
    if (!isRecord(h) || Object.keys(h).length === 0) return null;
    return fromHash(h, now());
  }

  return {
    createApproval: (svc, a) =>
      guard(async () => {
        const id = nanoid();
        const created = now();
        const expiresAtMs = created + APPROVAL_TTL_SECONDS * 1000;
        const approval: Approval = {
          ...a,
          serviceId: svc,
          id,
          status: "pending",
          createdAt: new Date(created).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
        const { status: _status, resolvedAt: _r, note: _n, ...immutable } = approval;
        void _status;
        void _r;
        void _n;
        const key = approvalKey(svc, id);
        await redis.hset(key, {
          data: JSON.stringify(immutable),
          status: "pending",
          expiresAtMs,
        });
        await redis.expire(key, APPROVAL_TTL_SECONDS);
        await redis.lpush(listKey(svc), id);
        await redis.ltrim(listKey(svc), 0, LIST_MAX - 1);
        await redis.expire(listKey(svc), LIST_TTL_SECONDS);
        return approval;
      }),

    getApproval: (svc, id) => guard(() => read(svc, id)),

    resolveApproval: (svc, id, d, note) =>
      guard(async () => {
        const t = now();
        const r = await redis.eval(
          RESOLVE_SCRIPT,
          [approvalKey(svc, id)],
          [d === "approve" ? "approved" : "denied", String(t), new Date(t).toISOString(), note ?? ""],
        );
        if (r === "ok" || r === "not_found" || r === "conflict") return r;
        throw new Error("unexpected");
      }),

    claimExecution: (svc, id) =>
      guard(async () => {
        const r = await redis.eval(CLAIM_SCRIPT, [approvalKey(svc, id)], [String(now())]);
        return Number(r) === 1;
      }),

    markExecuted: (svc, id) =>
      guard(async () => {
        await redis.eval(MARK_EXECUTED_SCRIPT, [approvalKey(svc, id)], []);
      }),

    listApprovals: (svc) =>
      guard(async () => {
        const ids = await redis.lrange(listKey(svc), 0, LIST_MAX - 1);
        const out: Approval[] = [];
        for (const id of ids) {
          const a = await read(svc, String(id));
          if (a) out.push(a);
        }
        return out;
      }),
  };
}
