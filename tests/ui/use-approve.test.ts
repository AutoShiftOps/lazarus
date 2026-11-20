import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ResolveApprovalResult } from "../../lib/ui/approvals-client";
import { createApproveController } from "../../lib/ui/use-approve";

function deferred(): {
  promise: Promise<ResolveApprovalResult>;
  resolve: (r: ResolveApprovalResult) => void;
} {
  let resolve!: (r: ResolveApprovalResult) => void;
  const promise = new Promise<ResolveApprovalResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const FAIL: ResolveApprovalResult = {
  ok: false,
  kind: "conflict",
  message: "This call was already resolved.",
};

describe("createApproveController", () => {
  it("sends once on a double click and returns the same promise", async () => {
    const d = deferred();
    const sent: ApprovalDecision[] = [];
    const c = createApproveController({
      send: (decision) => {
        sent.push(decision);
        return d.promise;
      },
    });
    const p1 = c.submit("approve");
    const p2 = c.submit("approve");
    expect(p2).toBe(p1);
    expect(c.getState().status).toBe("sending");
    d.resolve({ ok: true });
    await p1;
    expect(sent).toEqual(["approve"]);
  });

  it("allows a retry after failure", async () => {
    const results: ResolveApprovalResult[] = [FAIL, { ok: true }];
    let calls = 0;
    const c = createApproveController({ send: async () => results[calls++] });
    await c.submit("approve");
    expect(c.getState()).toEqual({ status: "error", message: FAIL.ok ? null : FAIL.message });
    await c.submit("approve");
    expect(calls).toBe(2);
    expect(c.getState().status).toBe("released");
  });

  it("is terminal after success", async () => {
    let calls = 0;
    const c = createApproveController({
      send: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    await c.submit("approve");
    expect(await c.submit("deny")).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(c.getState().status).toBe("released");
  });

  it("shares the guard between approve and deny", async () => {
    const d = deferred();
    const sent: ApprovalDecision[] = [];
    const c = createApproveController({
      send: (decision) => {
        sent.push(decision);
        return d.promise;
      },
    });
    const p1 = c.submit("approve");
    const p2 = c.submit("deny");
    expect(p2).toBe(p1);
    d.resolve({ ok: true });
    await p1;
    expect(sent).toEqual(["approve"]);
  });

  it("turns a thrown send into an error state", async () => {
    const c = createApproveController({
      send: async () => {
        throw new Error("boom");
      },
    });
    const r = await c.submit("approve");
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
    expect(c.getState().status).toBe("error");
  });
});
