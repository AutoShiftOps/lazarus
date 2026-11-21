import { describe, expect, it } from "vitest";
import { listTranscripts } from "../../lib/ui/transcripts-client";

type Call = { url: string; init: RequestInit };

function fakeFetch(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return res();
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const entry = {
  id: "t1",
  ts: "2026-01-01T00:00:00.000Z",
  tool: "GetBalance",
  args: { a: 1 },
  risk: "read",
  decision: "allow",
  outcome: "ok",
  durationMs: 12,
  summary: "ok",
};

describe("listTranscripts", () => {
  it("returns parsed entries", async () => {
    const f = fakeFetch(() => json([entry]));
    const r = await listTranscripts("abcd1234", { fetch: f.fetch });
    expect(r).toEqual({ ok: true, entries: [entry] });
    expect(f.calls[0]?.url).toBe("/api/services/abcd1234/transcripts");
  });

  it.each([
    [401, "unauthorized", "Only the owner can read this transcript."],
    [403, "unauthorized", "Only the owner can read this transcript."],
    [404, "not_found", "This spirit has passed on."],
    [429, "rate_limited", "Too many attempts. Wait a moment."],
    [500, "unavailable", "The spirits are unreachable. Try again."],
  ])("maps status %i", async (status, kind, message) => {
    const f = fakeFetch(() => json({ error: "server secret text" }, status));
    const r = await listTranscripts("abcd1234", { fetch: f.fetch });
    expect(r).toEqual({ ok: false, kind, message });
  });

  it("sends the owner header only with a token", async () => {
    const f = fakeFetch(() => json([]));
    await listTranscripts("abcd1234", { fetch: f.fetch });
    await listTranscripts("abcd1234", { fetch: f.fetch, ownerToken: "tok" });
    expect(f.calls[0]?.init.headers).toEqual({});
    expect(f.calls[1]?.init.headers).toEqual({ "x-lazarus-owner": "tok" });
    expect(f.calls[1]?.url).not.toContain("tok");
  });

  it("treats a bad shape and network errors as unavailable", async () => {
    const bad = fakeFetch(() => json([{ ...entry, decision: "maybe" }]));
    expect((await listTranscripts("abcd1234", { fetch: bad.fetch })).ok).toBe(false);
    const notList = fakeFetch(() => json({ nope: 1 }));
    const r = await listTranscripts("abcd1234", { fetch: notList.fetch });
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
    const down = fakeFetch(() => Promise.reject(new Error("boom")));
    expect(await listTranscripts("abcd1234", { fetch: down.fetch })).toMatchObject({ kind: "unavailable" });
  });
});
