import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  MSG_GENERIC,
  MSG_RATE_LIMITED,
  raiseDemo,
  summonWsdl,
  type FetchFn,
} from "../../lib/ui/summon-client";
import { stageLabel } from "../../lib/ui/summon-stages";

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
const ID = "AbCd1234";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetching(res: Response | (() => Promise<Response>)): { fn: FetchFn; calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fn: FetchFn = async (input, init) => {
    calls.push([input, init]);
    return typeof res === "function" ? res() : res;
  };
  return { fn, calls };
}

describe("summonWsdl", () => {
  it("posts JSON and returns id with token", async () => {
    const f = fetching(json({ id: ID, ownerToken: TOKEN }));
    const out = await summonWsdl(f.fn, "http://x.test/a?WSDL");
    expect(out).toEqual({ ok: true, serviceId: ID, ownerToken: TOKEN });
    expect(f.calls[0][0]).toBe("/api/summon");
    expect(f.calls[0][1]?.method).toBe("POST");
    expect(f.calls[0][1]?.body).toBe(JSON.stringify({ wsdlUrl: "http://x.test/a?WSDL" }));
    expect(f.calls[0][1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("succeeds without a token", async () => {
    const out = await summonWsdl(fetching(json({ id: ID })).fn, "http://x.test");
    expect(out).toEqual({ ok: true, serviceId: ID });
  });

  it("uses the API error text", async () => {
    const out = await summonWsdl(fetching(json({ error: "Invalid URL.", code: "X" }, 400)).fn, "x");
    expect(out).toEqual({ ok: false, message: "Invalid URL." });
  });

  it("caps long error text at 300 characters", async () => {
    const out = await summonWsdl(fetching(json({ error: "a".repeat(1000) }, 400)).fn, "x");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("uses the friendly sentence for 429", async () => {
    const out = await summonWsdl(fetching(json({ error: "other" }, 429)).fn, "x");
    expect(out).toEqual({ ok: false, message: MSG_RATE_LIMITED });
  });

  it("returns a generic message when fetch rejects", async () => {
    const out = await summonWsdl(fetching(() => Promise.reject(new Error("boom"))).fn, "x");
    expect(out).toEqual({ ok: false, message: MSG_GENERIC });
  });

  it("returns a generic message for malformed JSON", async () => {
    const out = await summonWsdl(fetching(new Response("<html>", { status: 200 })).fn, "x");
    expect(out).toEqual({ ok: false, message: MSG_GENERIC });
  });

  it("returns a generic message for a malformed JSON error response", async () => {
    const out = await summonWsdl(fetching(new Response("oops", { status: 500 })).fn, "x");
    expect(out).toEqual({ ok: false, message: MSG_GENERIC });
  });

  it("fails when the id is missing or malformed", async () => {
    expect(await summonWsdl(fetching(json({ ownerToken: TOKEN })).fn, "x")).toEqual({
      ok: false,
      message: MSG_GENERIC,
    });
    expect(await summonWsdl(fetching(json({ id: "../x" })).fn, "x")).toEqual({
      ok: false,
      message: MSG_GENERIC,
    });
  });

  it("never puts the token in a failure message", async () => {
    const cases: Response[] = [
      json({ ownerToken: TOKEN }),
      json({ ownerToken: TOKEN, error: "" }, 500),
      json({ id: "bad id", ownerToken: TOKEN }),
      json({ ownerToken: TOKEN }, 429),
    ];
    for (const res of cases) {
      const out = await summonWsdl(fetching(res).fn, "x");
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
  });
});

describe("raiseDemo", () => {
  it("posts without a body and reads serviceId and token", async () => {
    const f = fetching(json({ serviceId: ID, ownerToken: TOKEN, sandboxId: "s" }));
    const out = await raiseDemo(f.fn);
    expect(out).toEqual({ ok: true, serviceId: ID, ownerToken: TOKEN });
    expect(f.calls[0][0]).toBe("/api/demo");
    expect(f.calls[0][1]?.method).toBe("POST");
    expect(f.calls[0][1]?.body).toBeUndefined();
  });

  it("does not accept the summon id field", async () => {
    const out = await raiseDemo(fetching(json({ id: ID })).fn);
    expect(out).toEqual({ ok: false, message: MSG_GENERIC });
  });

  it("maps 429 and API errors", async () => {
    expect(await raiseDemo(fetching(json({ error: "x" }, 429)).fn)).toEqual({
      ok: false,
      message: MSG_RATE_LIMITED,
    });
    expect(await raiseDemo(fetching(json({ error: "Not available." }, 503)).fn)).toEqual({
      ok: false,
      message: "Not available.",
    });
  });

  it("handles network errors", async () => {
    const out = await raiseDemo(fetching(() => Promise.reject(new TypeError("net"))).fn);
    expect(out).toEqual({ ok: false, message: MSG_GENERIC });
  });
});

describe("stageLabel", () => {
  it("advances at 1.5 s and 3.5 s for summon", () => {
    expect(stageLabel("summon", 0)).toBe("Fetching the WSDL…");
    expect(stageLabel("summon", 1499)).toBe("Fetching the WSDL…");
    expect(stageLabel("summon", 1500)).toBe("Reading the runes…");
    expect(stageLabel("summon", 3499)).toBe("Reading the runes…");
    expect(stageLabel("summon", 3500)).toBe("Raising the spirits…");
  });

  it("starts with the sandbox stage for the demo", () => {
    expect(stageLabel("demo", 0)).toBe("Raising a sandbox…");
    expect(stageLabel("demo", 1500)).toBe("Reading the runes…");
    expect(stageLabel("demo", 9000)).toBe("Raising the spirits…");
  });
});
