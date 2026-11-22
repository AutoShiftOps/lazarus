import { describe, expect, it } from "vitest";
import { getSettings, patchSettings, SETTINGS_MESSAGES } from "../../lib/ui/settings-client";

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

const STATUSES: Array<[number, string]> = [
  [401, "Only the owner can change this."],
  [403, "Only the owner can change this."],
  [404, "This spirit has passed on."],
  [400, "That change was not accepted."],
  [429, "Too many attempts. Wait a moment."],
  [500, "The spirits are unreachable. Try again."],
];

describe("settings-client", () => {
  it("reads ghost from the service summary", async () => {
    const f = fakeFetch(() => json({ id: "x", ghost: true, rules: [] }));
    expect(await getSettings("svc", { fetch: f.fetch })).toEqual({ ok: true, ghost: true });
    expect(f.calls[0].url).toBe("/api/services/svc");
  });

  it("patches with a JSON body and returns the saved value", async () => {
    const f = fakeFetch(() => json({ ghost: false }));
    const r = await patchSettings("svc", false, { fetch: f.fetch, ownerToken: TOKEN });
    expect(r).toEqual({ ok: true, ghost: false });
    expect(f.calls[0].url).toBe("/api/services/svc/settings");
    expect(f.calls[0].init.method).toBe("PATCH");
    expect(f.calls[0].init.body).toBe('{"ghost":false}');
  });

  it("sends the owner header only when a token is given", async () => {
    const f = fakeFetch(() => json({ ghost: true }));
    await patchSettings("svc", true, { fetch: f.fetch, ownerToken: TOKEN });
    await patchSettings("svc", true, { fetch: f.fetch, ownerToken: null });
    const withToken = f.calls[0].init.headers as Record<string, string>;
    const without = f.calls[1].init.headers as Record<string, string>;
    expect(withToken["x-lazarus-owner"]).toBe(TOKEN);
    expect(Object.keys(without)).not.toContain("x-lazarus-owner");
  });

  it.each(STATUSES)("maps status %i to a fixed message", async (status, message) => {
    const f = fakeFetch(() => json({ error: "SECRET server text" }, status));
    const r = await patchSettings("svc", true, { fetch: f.fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(message);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("treats a bad response shape or a network error as unavailable", async () => {
    const bad = fakeFetch(() => json({ ghost: "yes" }));
    const r1 = await getSettings("svc", { fetch: bad.fetch });
    expect(r1).toEqual({ ok: false, kind: "unavailable", message: SETTINGS_MESSAGES.unavailable });
    const boom = fakeFetch(() => {
      throw new Error("down");
    });
    const r2 = await patchSettings("svc", true, { fetch: boom.fetch });
    expect(r2.ok).toBe(false);
  });
});
