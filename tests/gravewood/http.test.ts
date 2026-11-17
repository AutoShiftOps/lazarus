import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientIp,
  createSandboxHttp,
  declaredTooLarge,
  requestTooLarge,
  resetHttp,
  soapHttp,
  wsdlHttp,
  type HttpResult,
} from "../../lib/gravewood/http";
import { seedState } from "../../lib/gravewood/seed";
import type { GwStore, RunResult } from "../../lib/gravewood/store";
import type { BankState } from "../../lib/gravewood/types";
import { buildWsdl } from "../../lib/gravewood/wsdl";

const ORIGIN = "https://example.test";
const ID = "AbCdEf123456";
const NS = "http://schemas.xmlsoap.org/soap/envelope/";
const op = (name: string, fields = "") =>
  `<Envelope xmlns="${NS}"><Body><${name} xmlns="urn:gravewood">${fields}</${name}></Body></Envelope>`;

type Overrides = Partial<{
  allowCreate: boolean;
  allowCall: boolean;
  failure: "conflict" | "too-large" | "unavailable" | "not-found";
  throwWith: string;
}>;

/** In-memory GwStore. Knobs let tests force each failure path. */
function fakeStore(o: Overrides = {}) {
  const states = new Map<string, BankState>();
  const boom = () => {
    if (o.throwWith) throw new Error(o.throwWith);
  };
  const store: GwStore = {
    async createSandbox() {
      boom();
      states.set(ID, seedState());
      return { id: ID, expiresAt: "2030-01-01T00:00:00.000Z" };
    },
    async loadState(id) {
      boom();
      return states.get(id) ?? null;
    },
    async runOnSandbox<T>(
      id: string,
      fn: (s: BankState) => { state: BankState; response: T },
    ): Promise<RunResult<T>> {
      boom();
      if (o.failure) return { ok: false, reason: o.failure };
      const cur = states.get(id);
      if (!cur) return { ok: false, reason: "not-found" };
      const r = fn(cur);
      states.set(id, r.state);
      return { ok: true, response: r.response };
    },
    async resetSandbox(id) {
      boom();
      if (!states.has(id)) return false;
      states.set(id, seedState());
      return true;
    },
    async allowCreate() {
      boom();
      return { allowed: o.allowCreate ?? true, retryAfter: 42 };
    },
    async allowCall() {
      boom();
      return { allowed: o.allowCall ?? true, retryAfter: 7 };
    },
  };
  return { store, states };
}

async function seeded(o: Overrides = {}) {
  const f = fakeStore();
  await f.store.createSandbox();
  // Apply overrides after seeding by rebuilding around the same state map.
  if (Object.keys(o).length === 0) return f;
  const g = fakeStore(o);
  g.states.set(ID, seedState());
  return g;
}

const everything = (r: HttpResult) => `${r.status}\n${JSON.stringify(r.headers)}\n${r.body}`;

describe("createSandboxHttp", () => {
  it("returns 201 with id, wsdl url and expiry", async () => {
    const { store } = fakeStore();
    const r = await createSandboxHttp("1.2.3.4", ORIGIN, { store });
    expect(r.status).toBe(201);
    expect(r.headers["Content-Type"]).toContain("application/json");
    expect(JSON.parse(r.body)).toEqual({
      sandboxId: ID,
      wsdlUrl: `${ORIGIN}/api/gravewood/${ID}/wsdl`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    const { store } = fakeStore({ allowCreate: false });
    const r = await createSandboxHttp("1.2.3.4", ORIGIN, { store });
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe("42");
    expect(JSON.parse(r.body).code).toBe("RATE_LIMITED");
  });
});

describe("wsdlHttp", () => {
  it("serves the WSDL for the origin", async () => {
    const { store } = await seeded();
    const r = await wsdlHttp(ID, ORIGIN, { store });
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(r.body).toBe(buildWsdl(`${ORIGIN}/api/gravewood/${ID}`));
  });

  it("returns 404 text for an unknown sandbox", async () => {
    const { store } = fakeStore();
    const r = await wsdlHttp("nope", ORIGIN, { store });
    expect(r.status).toBe(404);
    expect(r.headers["Content-Type"]).toContain("text/plain");
    expect(r.body).toBe("Sandbox not found or expired.");
  });
});

describe("soapHttp", () => {
  it("answers GetBalance with the seeded balance", async () => {
    const { store } = await seeded();
    const r = await soapHttp(
      ID,
      '"urn:gravewood:GetBalance"',
      op("GetBalance", "<accountId>4471</accountId>"),
      { store },
    );
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(r.body).toContain("<balance>12450.00</balance>");
  });

  it("persists a transfer so GetBalance shows the new balance", async () => {
    const { store } = await seeded();
    const t = await soapHttp(
      ID,
      null,
      op(
        "TransferFunds",
        "<fromAccount>4471</fromAccount><toAccount>5530</toAccount><amount>100.00</amount>",
      ),
      { store },
    );
    expect(t.status).toBe(200);
    const b = await soapHttp(ID, null, op("GetBalance", "<accountId>4471</accountId>"), { store });
    expect(b.body).toContain("<balance>12350.00</balance>");
  });

  it("returns a 500 Fault on SOAPAction mismatch", async () => {
    const { store } = await seeded();
    const r = await soapHttp(
      ID,
      "urn:gravewood:ListAccounts",
      op("GetBalance", "<accountId>4471</accountId>"),
      { store },
    );
    expect(r.status).toBe(500);
    expect(r.body).toContain("SOAPAction mismatch");
  });

  it("returns 413 by actual UTF-8 byte size", async () => {
    const { store } = await seeded();
    const big = "é".repeat(32769); // 65538 bytes, 32769 chars
    const r = await soapHttp(ID, null, big, { store });
    expect(r.status).toBe(413);
    expect(r.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(r.body).toContain("Request too large");
  });

  it("accepts a body of exactly 65536 bytes", async () => {
    const { store } = await seeded();
    const r = await soapHttp(ID, null, "a".repeat(65536), { store });
    expect(r.status).toBe(500); // malformed, but not 413
    expect(r.body).toContain("Malformed request");
  });

  it("returns 429 with Retry-After and a Client Fault", async () => {
    const { store } = await seeded({ allowCall: false });
    const r = await soapHttp(ID, null, op("ListAccounts"), { store });
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe("7");
    expect(r.body).toContain("Too many requests");
  });

  it("returns 404 Fault for an unknown sandbox", async () => {
    const { store } = fakeStore();
    const r = await soapHttp("missing", null, op("ListAccounts"), { store });
    expect(r.status).toBe(404);
    expect(r.body).toContain("Sandbox not found or expired");
  });

  it.each([
    ["conflict", 500, "Please retry"],
    ["too-large", 500, "Sandbox is full. Reset it to continue."],
    ["unavailable", 503, "The bank is temporarily unavailable."],
    ["not-found", 404, "Sandbox not found or expired"],
  ] as const)("maps %s", async (failure, status, text) => {
    const { store } = await seeded({ failure });
    const r = await soapHttp(ID, null, op("ListAccounts"), { store });
    expect(r.status).toBe(status);
    expect(r.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(r.body).toContain(text);
  });
});

describe("resetHttp", () => {
  it("restores the seed state", async () => {
    const { store, states } = await seeded();
    await soapHttp(
      ID,
      null,
      op(
        "TransferFunds",
        "<fromAccount>4471</fromAccount><toAccount>5530</toAccount><amount>100.00</amount>",
      ),
      { store },
    );
    expect(states.get(ID)).not.toEqual(seedState());
    const r = await resetHttp(ID, { store });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ reset: true });
    expect(states.get(ID)).toEqual(seedState());
  });

  it("returns 404 JSON for an unknown sandbox", async () => {
    const { store } = fakeStore();
    const r = await resetHttp("missing", { store });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({
      error: "Sandbox not found or expired.",
      code: "NOT_FOUND",
    });
  });

  it("returns 429 with Retry-After", async () => {
    const { store } = await seeded({ allowCall: false });
    const r = await resetHttp(ID, { store });
    expect(r.status).toBe(429);
    expect(r.headers["Retry-After"]).toBe("7");
  });
});

describe("store failures", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it("never leaks the thrown message from any function", async () => {
    const { store } = fakeStore({ throwWith: "boom-SECRET gw:key /var/path" });
    const results = await Promise.all([
      createSandboxHttp("1.1.1.1", ORIGIN, { store }),
      wsdlHttp(ID, ORIGIN, { store }),
      soapHttp(ID, null, op("ListAccounts"), { store }),
      resetHttp(ID, { store }),
    ]);
    for (const r of results) {
      expect(r.status).toBe(503);
      const all = everything(r);
      expect(all).not.toContain("boom-SECRET");
      expect(all).not.toContain("gw:");
      expect(all).not.toContain("/var/path");
      expect(r.body).toContain("The bank is temporarily unavailable.");
    }
    expect(JSON.parse(results[0].body).code).toBe("UNAVAILABLE");
    expect(JSON.parse(results[3].body).code).toBe("UNAVAILABLE");
    expect(results[2].body).toContain("Server");
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("boom-SECRET");
    }
  });
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for value, trimmed", () => {
    const h = new Headers({ "x-forwarded-for": " 9.9.9.9 , 8.8.8.8" });
    expect(clientIp(h)).toBe("9.9.9.9");
  });
  it("falls back to x-real-ip", () => {
    expect(clientIp(new Headers({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
  });
  it("falls back to unknown", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("content-length check", () => {
  it("flags a declared size over the cap", () => {
    expect(declaredTooLarge(new Headers({ "content-length": "65537" }))).toBe(true);
    expect(declaredTooLarge(new Headers({ "content-length": "65536" }))).toBe(false);
    expect(declaredTooLarge(new Headers())).toBe(false);
    expect(declaredTooLarge(new Headers({ "content-length": "abc" }))).toBe(false);
  });
  it("builds a 413 XML fault", () => {
    const r = requestTooLarge();
    expect(r.status).toBe(413);
    expect(r.headers["Content-Type"]).toBe("text/xml; charset=utf-8");
    expect(r.body).toContain("Request too large");
  });
});
