import { describe, expect, it } from "vitest";
import { listApprovals, resolveApproval } from "../../lib/ui/approvals-client";

type Call = { url: string; init: RequestInit };

function fakeFetch(res: () => Response | Promise<Response>): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return res();
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const approval = {
  id: "a1",
  tool: "CloseAccount",
  args: { accountId: "x" },
  risk: "destructive",
  reason: "held",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:05:00.000Z",
};

const MESSAGES: Array<[number, string, string]> = [
  [401, "unauthorized", "Only the owner can release calls."],
  [403, "unauthorized", "Only the owner can release calls."],
  [404, "not_found", "This call is gone."],
  [409, "conflict", "This call was already resolved."],
  [429, "rate_limited", "Too many attempts. Wait a moment."],
  [500, "unavailable", "The spirits are unreachable. Try again."],
  [503, "unavailable", "The spirits are unreachable. Try again."],
];

describe("listApprovals", () => {
  it("returns validated approvals", async () => {
    const f = fakeFetch(() => json([approval]));
    const r = await listApprovals("svc", { fetch: f.fetch });
    expect(r).toEqual({ ok: true, approvals: [approval] });
    expect(f.calls[0].url).toBe("/api/services/svc/approvals");
  });

  it.each(MESSAGES)("maps %i to %s with a fixed message", async (status, kind, message) => {
    const f = fakeFetch(() => json({ error: "server secret text", code: "X" }, status));
    const r = await listApprovals("svc", { fetch: f.fetch });
    expect(r).toEqual({ ok: false, kind, message });
  });

  it("sends the owner header only when a token is given, never in the URL", async () => {
    const without = fakeFetch(() => json([]));
    await listApprovals("svc", { fetch: without.fetch });
    expect(without.calls[0].init.headers).not.toHaveProperty("x-lazarus-owner");

    const token = "tok_abcdefghijklmnopqrstuvwxyz";
    const withTok = fakeFetch(() => json([]));
    await listApprovals("svc", { fetch: withTok.fetch, ownerToken: token });
    expect(withTok.calls[0].init.headers).toMatchObject({ "x-lazarus-owner": token });
    expect(withTok.calls[0].url).not.toContain(token);
  });

  it("treats a bad shape as unavailable instead of dropping items", async () => {
    const f = fakeFetch(() => json([approval, { id: "b" }]));
    const r = await listApprovals("svc", { fetch: f.fetch });
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("treats malformed JSON as unavailable", async () => {
    const f = fakeFetch(() => new Response("not json{", { status: 200 }));
    const r = await listApprovals("svc", { fetch: f.fetch });
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("treats a network error as unavailable", async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError("fail")));
    const r = await listApprovals("svc", { fetch: f.fetch });
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("passes the abort signal and reports unavailable when aborted", async () => {
    const ctrl = new AbortController();
    const fetchImpl = (_u: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      });
    const p = listApprovals("svc", { fetch: fetchImpl, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, kind: "unavailable" });
  });
});

describe("resolveApproval", () => {
  it("posts the decision and note", async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const r = await resolveApproval("svc", "a1", "approve", { fetch: f.fetch, note: "ok" });
    expect(r).toEqual({ ok: true });
    expect(f.calls[0].url).toBe("/api/services/svc/approvals/a1");
    expect(f.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ decision: "approve", note: "ok" });
  });

  it("omits an absent note", async () => {
    const f = fakeFetch(() => json({}));
    await resolveApproval("svc", "a1", "deny", { fetch: f.fetch });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ decision: "deny" });
  });

  it.each(MESSAGES)("maps %i to %s with a fixed message", async (status, kind, message) => {
    const f = fakeFetch(() => json({ error: "leak", code: "X" }, status));
    expect(await resolveApproval("svc", "a1", "approve", { fetch: f.fetch })).toEqual({
      ok: false,
      kind,
      message,
    });
  });

  it("sends the owner header only with a token", async () => {
    const token = "tok_abcdefghijklmnopqrstuvwxyz";
    const a = fakeFetch(() => json({}));
    await resolveApproval("svc", "a1", "approve", { fetch: a.fetch });
    expect(a.calls[0].init.headers).not.toHaveProperty("x-lazarus-owner");
    const b = fakeFetch(() => json({}));
    await resolveApproval("svc", "a1", "approve", { fetch: b.fetch, ownerToken: token });
    expect(b.calls[0].init.headers).toMatchObject({ "x-lazarus-owner": token });
    expect(b.calls[0].url).not.toContain(token);
  });

  it("reports unavailable on abort", async () => {
    const ctrl = new AbortController();
    const fetchImpl = (_u: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      });
    const p = resolveApproval("svc", "a1", "deny", { fetch: fetchImpl, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, kind: "unavailable" });
  });
});
