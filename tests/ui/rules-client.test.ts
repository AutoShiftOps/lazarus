import { describe, expect, it } from "vitest";
import type { Rule } from "../../lib/safety/types";
import { getRules, putRules, RULES_MESSAGES } from "../../lib/ui/rules-client";

type Call = { url: string; init: RequestInit };

function fakeFetch(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      return res();
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";

const rule: Rule = {
  id: "r1",
  operation: "TransferFunds",
  when: { field: "amount", op: "gt", value: 1000 },
  effect: "hold",
  reason: "Large transfer",
};

const STATUSES: Array<[number, string]> = [
  [401, "Only the owner can change rules."],
  [404, "This spirit has passed on."],
  [400, "The rules were not accepted."],
  [413, "The rules were not accepted."],
  [429, "Too many attempts. Wait a moment."],
  [503, "The spirits are unreachable. Try again."],
];

describe("rules-client", () => {
  it("reads rules from the service summary", async () => {
    const f = fakeFetch(() => json({ id: "x", ghost: false, rules: [rule] }));
    expect(await getRules("svc", { fetch: f.fetch })).toEqual({ ok: true, rules: [rule] });
    expect(f.calls[0].url).toBe("/api/services/svc");
  });

  it("puts the bare array and returns the saved list", async () => {
    const f = fakeFetch(() => json([rule]));
    const r = await putRules("svc", [rule], { fetch: f.fetch, ownerToken: TOKEN });
    expect(r).toEqual({ ok: true, rules: [rule] });
    expect(f.calls[0].url).toBe("/api/services/svc/rules");
    expect(f.calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual([rule]);
  });

  it("sends the owner header only when a token is given", async () => {
    const f = fakeFetch(() => json([]));
    await putRules("svc", [], { fetch: f.fetch, ownerToken: TOKEN });
    await putRules("svc", [], { fetch: f.fetch });
    expect((f.calls[0].init.headers as Record<string, string>)["x-lazarus-owner"]).toBe(TOKEN);
    expect(Object.keys(f.calls[1].init.headers as Record<string, string>)).not.toContain("x-lazarus-owner");
  });

  it.each(STATUSES)("maps status %i to a fixed message", async (status, message) => {
    const f = fakeFetch(() => json({ error: "SECRET server text" }, status));
    const r = await putRules("svc", [], { fetch: f.fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(message);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("rejects a response that is not a valid rule list", async () => {
    const bad = fakeFetch(() => json({ rules: [{ id: "r", effect: "maybe" }] }));
    expect(await getRules("svc", { fetch: bad.fetch })).toEqual({
      ok: false,
      kind: "unavailable",
      message: RULES_MESSAGES.unavailable,
    });
    const notArray = fakeFetch(() => json({ rules: [] }));
    expect((await putRules("svc", [], { fetch: notArray.fetch })).ok).toBe(false);
  });
});
