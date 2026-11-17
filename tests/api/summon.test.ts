import { afterEach, describe, expect, it, vi } from "vitest";
import { summon, summonFromBody, type SummonDeps, type SummonResponse } from "../../lib/summon";
import { createHash } from "node:crypto";
import { classifyOperations, heuristicRisk } from "../../lib/soap/risk";
import { generateOwnerToken } from "../../lib/owner-token";
import type {
  ErrorCode,
  LazarusError,
  OperationSchema,
  ServiceDefinition,
  Warning,
} from "../../lib/soap/types";

const ORIGIN = "https://lazarus.test";
const URL_OK = "http://example.com/c?WSDL";

function makeOp(name: string, warnings: Warning[] = []): OperationSchema {
  return {
    name,
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: `http://x/${name}`,
    targetNamespace: "http://x/",
    inputElementName: name,
    outputElementName: `${name}Response`,
    endpointAddress: "http://internal.example/svc",
    elementFormDefault: "qualified",
    risk: "write",
    riskReason: "test",
    riskSource: "heuristic",
    inputDescriptor: [],
    outputDescriptor: [],
    warnings,
  };
}

function makeDef(ops: OperationSchema[], warnings: Warning[] = []): ServiceDefinition {
  return {
    name: "Calc",
    wsdlUrl: "http://redirected.example.com/c?WSDL",
    ports: [{ name: "P", address: "http://internal.example/svc", operations: ops }],
    warnings,
  };
}

function lzError(code: ErrorCode, message = "Readable message.", detail?: string): LazarusError {
  return { code, message, detail } as LazarusError;
}

type Overrides = Partial<SummonDeps>;

function makeDeps(overrides: Overrides = {}, def: ServiceDefinition = makeDef([makeOp("Add")])) {
  const upsert = vi.fn(async (_d: ServiceDefinition) => ({
    ok: true as const,
    id: "abcd1234",
    created: true,
  }));
  const deps: SummonDeps = {
    fetchWsdl: async () => ({ ok: true, xml: "<x/>", finalUrl: "http://final.example.com/c" }),
    parseWsdl: async () => ({ ok: true, definition: def }),
    generateSchemas: (s) => {
      const m = new Map<string, OperationSchema>();
      for (const p of s.ports) for (const o of p.operations) m.set(o.name, structuredClone(o));
      return m;
    },
    upsertService: upsert,
    classifyOperations: (ops) => classifyOperations(ops),
    generateOwnerToken,
    ...overrides,
  };
  return { deps, upsert };
}

function expectSafeError(res: SummonResponse, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = res.body as { error: string; code: string };
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.error.length).toBeLessThanOrEqual(500);
  expect(body.error).not.toContain("    at ");
  expect(body.error).not.toContain("node_modules");
  return body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summon API: 200", () => {
  it("returns the public shape and leaks no internal keys", async () => {
    const { deps } = makeDeps();
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.id).toBe("abcd1234");
    expect(body.name).toBe("Calc");
    expect(body.wsdlUrl).toBe(URL_OK);
    expect(body.mcpUrl).toBe(`${ORIGIN}/api/mcp/abcd1234`);
    expect(Array.isArray(body.operations)).toBe(true);
    expect((body.operations as { name: string }[])[0].name).toBe("Add");
    expect(body.warnings).toEqual([]);
    const json = JSON.stringify(body);
    expect(json).not.toContain("endpointAddress");
    expect(json).not.toContain("inputDescriptor");
    expect(json).not.toContain("outputDescriptor");
    expect(json).not.toContain("Descriptor");
  });
});

describe("summon API: 400", () => {
  const never = () => {
    throw new Error("should not be called");
  };
  const guarded: Overrides = {
    fetchWsdl: never as unknown as SummonDeps["fetchWsdl"],
  };

  it("rejects a body that is not JSON", async () => {
    const res = await summonFromBody("not json{", ORIGIN, guarded);
    expectSafeError(res, 400, "INVALID_REQUEST");
  });

  it("rejects a body with the wrong key", async () => {
    const res = await summonFromBody(JSON.stringify({ url: URL_OK }), ORIGIN, guarded);
    expectSafeError(res, 400, "INVALID_REQUEST");
  });

  it("rejects a body with an extra key", async () => {
    const res = await summonFromBody(
      JSON.stringify({ wsdlUrl: URL_OK, extra: 1 }),
      ORIGIN,
      guarded,
    );
    expectSafeError(res, 400, "INVALID_REQUEST");
  });

  it.each(["ftp://example.com/x.wsdl", "not a url", "file:///etc/passwd"])(
    "rejects bad URL %s with the exact message",
    async (bad) => {
      const res = await summonFromBody(JSON.stringify({ wsdlUrl: bad }), ORIGIN, guarded);
      const body = expectSafeError(res, 400, "INVALID_REQUEST");
      expect(body.error).toBe("Invalid URL — only HTTP and HTTPS are supported.");
    },
  );

  it("rejects a URL longer than 2048 characters", async () => {
    const long = "http://example.com/" + "a".repeat(2049);
    const res = await summon(long, ORIGIN, guarded);
    expectSafeError(res, 400, "INVALID_REQUEST");
  });

  it("rejects a body larger than 4096 bytes", async () => {
    const raw = JSON.stringify({ wsdlUrl: "http://example.com/" + "a".repeat(4100) });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(4096);
    const res = await summonFromBody(raw, ORIGIN, guarded);
    expectSafeError(res, 400, "INVALID_REQUEST");
  });

  it("passes SSRF_BLOCKED through", async () => {
    const { deps } = makeDeps({
      fetchWsdl: async () => ({ ok: false, error: lzError("SSRF_BLOCKED", "Blocked address.") }),
    });
    const res = await summon(URL_OK, ORIGIN, deps);
    const body = expectSafeError(res, 400, "SSRF_BLOCKED");
    expect(body.error).toBe("Blocked address.");
  });
});

describe("summon API: 4xx/5xx mapping", () => {
  it("returns 422 when parsing fails", async () => {
    const { deps } = makeDeps({
      parseWsdl: async () => ({ ok: false, error: lzError("WSDL_PARSE_FAILED") }),
    });
    expectSafeError(await summon(URL_OK, ORIGIN, deps), 422, "WSDL_PARSE_FAILED");
  });

  it("returns 422 when the WSDL is too large", async () => {
    const { deps } = makeDeps({
      fetchWsdl: async () => ({ ok: false, error: lzError("WSDL_TOO_LARGE") }),
    });
    expectSafeError(await summon(URL_OK, ORIGIN, deps), 422, "WSDL_TOO_LARGE");
  });

  it("returns 502 when the fetch fails", async () => {
    const { deps } = makeDeps({
      fetchWsdl: async () => ({ ok: false, error: lzError("WSDL_FETCH_FAILED") }),
    });
    expectSafeError(await summon(URL_OK, ORIGIN, deps), 502, "WSDL_FETCH_FAILED");
  });

  it("returns 504 with code WSDL_FETCH_FAILED on TIMEOUT", async () => {
    const { deps } = makeDeps({
      fetchWsdl: async () => ({ ok: false, error: lzError("TIMEOUT") }),
    });
    expectSafeError(await summon(URL_OK, ORIGIN, deps), 504, "WSDL_FETCH_FAILED");
  });

  it("returns 503 when the registry is unavailable", async () => {
    const { deps } = makeDeps({
      upsertService: async () => ({ ok: false, error: lzError("REGISTRY_UNAVAILABLE") }),
    });
    expectSafeError(await summon(URL_OK, ORIGIN, deps), 503, "REGISTRY_UNAVAILABLE");
  });
});

describe("summon API: 500 and secrecy", () => {
  it("returns a generic 500 and logs without the secret when a dep throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({
      parseWsdl: async () => {
        throw new Error("boom SECRET-123");
      },
    });
    const res = await summon(URL_OK, ORIGIN, deps);
    const body = expectSafeError(res, 500, "INTERNAL_ERROR");
    expect(body.error).toBe("An unexpected error occurred.");
    expect(JSON.stringify(res.body)).not.toContain("SECRET-123");
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe("string");
        expect(arg as string).not.toContain("SECRET-123");
      }
    }
  });

  it("never exposes LazarusError.detail in the response", async () => {
    const { deps } = makeDeps({
      fetchWsdl: async () => ({
        ok: false,
        error: lzError("WSDL_FETCH_FAILED", "Could not fetch.", "SECRET-123 at /srv/app.ts"),
      }),
    });
    const res = await summon(URL_OK, ORIGIN, deps);
    expectSafeError(res, 502, "WSDL_FETCH_FAILED");
    expect(JSON.stringify(res.body)).not.toContain("SECRET-123");
  });
});

describe("summon API: sanitiser", () => {
  it("sanitiser removes a path fragment glued to a URL", async () => {
    const msg = "/0.tshttps://example.com/a.jsError: boom\n    at ";
    const { deps } = makeDeps({ fetchWsdl: async () => ({ ok: false, error: lzError("INVALID_REQUEST", msg) }) });
    const res = await summon(URL_OK, ORIGIN, deps);
    const text = (res.body as { error: string }).error;
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).not.toContain("    at ");
    expect(text).not.toContain("node_modules");
    expect(text.replace(/https?:\/\/\S+/gi, "")).not.toMatch(/[\\/][\w.-]+\.(?:ts|js|mjs|cjs)\b/);
  });
});

describe("summon API: caps", () => {
  it("caps operations at 500", async () => {
    const ops = Array.from({ length: 520 }, (_, i) => makeOp(`Op${i}`));
    const { deps } = makeDeps({}, makeDef(ops));
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    expect((res.body as { operations: unknown[] }).operations).toHaveLength(500);
  });

  it("caps warnings at 49", async () => {
    const warnings = Array.from({ length: 60 }, (_, i) => ({ code: "W", message: `w${i}` }));
    const { deps } = makeDeps({}, makeDef([makeOp("Add")], warnings));
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    expect((res.body as { warnings: unknown[] }).warnings).toHaveLength(49);
  });
});

describe("summon API: stored definition", () => {
  it("stores the submitted wsdlUrl and the generateSchemas warning copies", async () => {
    const original = makeDef([makeOp("Add")]);
    const { deps, upsert } = makeDeps(
      {
        generateSchemas: (s) => {
          const copy = structuredClone(s.ports[0].operations[0]);
          copy.warnings = [{ code: "GEN", message: "generated warning" }];
          return new Map([["Add", copy]]);
        },
      },
      original,
    );
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    const stored = upsert.mock.calls[0][0];
    expect(stored.wsdlUrl).toBe(URL_OK);
    expect(stored.ports[0].operations[0].warnings).toEqual([
      { code: "GEN", message: "generated warning" },
    ]);
    expect(original.ports[0].operations[0].warnings).toEqual([]);
  });
});

describe("summon API: owner token and risk", () => {
  it("returns a 43-char ownerToken on first summon and stores only its hash", async () => {
    const { deps, upsert } = makeDeps();
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    const token = (res.body as { ownerToken?: string }).ownerToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = upsert.mock.calls[0][0];
    expect(stored.ownerTokenHash).toBe(createHash("sha256").update(token as string).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token as string);
  });

  it("omits ownerToken entirely when the service already exists", async () => {
    const { deps } = makeDeps({
      upsertService: async () => ({ ok: true as const, id: "abcd1234", created: false }),
    });
    const res = await summon(URL_OK, ORIGIN, deps);
    expect(res.status).toBe(200);
    expect("ownerToken" in (res.body as object)).toBe(false);
  });

  it("never includes ownerTokenHash or the hash value in a 200 body", async () => {
    for (const created of [true, false]) {
      const { deps, upsert } = makeDeps({
        upsertService: async (d) => {
          upsertSeen.push(d);
          return { ok: true as const, id: "abcd1234", created };
        },
      });
      const upsertSeen: ServiceDefinition[] = [];
      void upsert;
      const res = await summon(URL_OK, ORIGIN, deps);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain("ownerTokenHash");
      expect(json).not.toContain(upsertSeen[0].ownerTokenHash as string);
    }
  });

  it("includes risk, riskReason and riskSource, classifying CloseAccount as destructive", async () => {
    // The schema generator assigns the heuristic class; mirror that in the fake.
    const classified = (name: string): OperationSchema => {
      const h = heuristicRisk(name);
      return { ...makeOp(name), risk: h.risk, riskReason: h.reason };
    };
    const { deps } = makeDeps({}, makeDef([classified("GetBalance"), classified("CloseAccount")]));
    const res = await summon(URL_OK, ORIGIN, deps);
    const ops = (res.body as { operations: Record<string, unknown>[] }).operations;
    for (const o of ops) {
      expect(typeof o.risk).toBe("string");
      expect(typeof o.riskReason).toBe("string");
      expect(typeof o.riskSource).toBe("string");
    }
    expect(ops.find((o) => o.name === "CloseAccount")?.risk).toBe("destructive");
  });

  it("never logs or returns the token on failure paths", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const TOKEN = "T".repeat(43);
    const gen = async () => ({ token: TOKEN, hash: "h".repeat(64) });
    const cases: Overrides[] = [
      { generateOwnerToken: gen, parseWsdl: async () => ({ ok: false, error: lzError("WSDL_PARSE_FAILED") }) },
      {
        generateOwnerToken: gen,
        upsertService: async () => ({ ok: false, error: lzError("REGISTRY_UNAVAILABLE") }),
      },
      {
        generateOwnerToken: gen,
        upsertService: async () => {
          throw new Error(`boom ${TOKEN}`);
        },
      },
    ];
    for (const c of cases) {
      const { deps } = makeDeps(c);
      const res = await summon(URL_OK, ORIGIN, deps);
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect("ownerToken" in (res.body as object)).toBe(false);
    }
    for (const spy of [err, log]) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});
