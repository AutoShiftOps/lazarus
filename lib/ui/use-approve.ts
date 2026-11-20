import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  resolveApproval,
  type ApprovalDecision,
  type ResolveApprovalResult,
} from "./approvals-client";

export type ApproveStatus = "idle" | "sending" | "released" | "error";

export interface ApproveState {
  status: ApproveStatus;
  message: string | null;
}

export interface ApproveController {
  /** Sends a decision. While one is pending, returns the same promise without sending again. */
  submit: (decision: ApprovalDecision, note?: string) => Promise<ResolveApprovalResult>;
  getState: () => ApproveState;
  subscribe: (listener: () => void) => () => void;
}

export interface ApproveControllerOptions {
  send: (decision: ApprovalDecision, note?: string) => Promise<ResolveApprovalResult>;
}

export function createApproveController({ send }: ApproveControllerOptions): ApproveController {
  let state: ApproveState = { status: "idle", message: null };
  let pending: Promise<ResolveApprovalResult> | null = null;
  let released: ResolveApprovalResult | null = null;
  const listeners = new Set<() => void>();

  const set = (next: ApproveState): void => {
    state = next;
    for (const l of listeners) l();
  };

  return {
    submit(decision, note) {
      if (released) return Promise.resolve(released); // terminal after success
      if (pending) return pending;
      set({ status: "sending", message: null });
      const run = (async (): Promise<ResolveApprovalResult> => {
        let result: ResolveApprovalResult;
        try {
          result = await send(decision, note);
        } catch {
          result = {
            ok: false,
            kind: "unavailable",
            message: "The spirits are unreachable. Try again.",
          };
        }
        pending = null;
        if (result.ok) {
          released = result;
          set({ status: "released", message: null });
        } else {
          set({ status: "error", message: result.message });
        }
        return result;
      })();
      pending = run;
      return run;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface UseApproveOptions {
  ownerToken?: string | null;
  fetch?: typeof fetch;
}

export interface UseApprove extends ApproveState {
  approve: (note?: string) => Promise<ResolveApprovalResult>;
  deny: (note?: string) => Promise<ResolveApprovalResult>;
}

interface ApproveSession {
  controller: ApproveController;
  setOptions: (options: UseApproveOptions) => void;
  abort: () => void;
}

/** Binds a controller to one approval and keeps the latest options and the in-flight abort handle. */
function createApproveSession(
  serviceId: string,
  approvalId: string,
  initial: UseApproveOptions,
): ApproveSession {
  let current = initial;
  let inflight: AbortController | null = null;
  const controller = createApproveController({
    send: (decision, note) => {
      const abort = new AbortController();
      inflight = abort;
      return resolveApproval(serviceId, approvalId, decision, {
        note,
        ownerToken: current.ownerToken,
        fetch: current.fetch,
        signal: abort.signal,
      });
    },
  });
  return {
    controller,
    setOptions: (next) => {
      current = next;
    },
    abort: () => inflight?.abort(),
  };
}

export function useApprove(
  serviceId: string,
  approvalId: string,
  options: UseApproveOptions = {},
): UseApprove {
  const session = useMemo(() => createApproveSession(serviceId, approvalId, options), [serviceId, approvalId]); // eslint-disable-line react-hooks/exhaustive-deps -- options are pushed through setOptions below
  const { controller } = session;
  const { ownerToken, fetch: fetchImpl } = options;

  useEffect(() => {
    session.setOptions({ ownerToken, fetch: fetchImpl });
  }, [session, ownerToken, fetchImpl]);

  useEffect(() => () => session.abort(), [session]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const approve = useCallback((note?: string) => controller.submit("approve", note), [controller]);
  const deny = useCallback((note?: string) => controller.submit("deny", note), [controller]);

  return { status: state.status, message: state.message, approve, deny };
}
