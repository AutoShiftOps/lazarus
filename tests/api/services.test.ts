import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientIpOf,
  getServiceSummary,
  guarded,
  isApprovalId,
  listServiceApprovals,
  listServiceTranscripts,
  patchServiceSettings,
  putServiceRules,
  readJsonBody,
  requireOwner,
  resolveServiceApproval,
  type ApprovalView,
  type ApprovalsDeps,
  type ServiceSummary,
} from "../../lib/api/services";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import { createPipeline } from "../../lib/mcp/pipeline";
import { buildTools } from "../../lib/mcp/tools";
import { generateOwnerToken } from "../../lib/owner-token";
import { createRegistry, type Registry } from "../../lib/registry";
import { createApprovals, type Approvals } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { Approval, TranscriptEntry } from "../../lib/safety/types";
import type { safePost } from "../../lib/soap/fetcher";
import { parseWsdl } from "../../lib/soap/parser";
import type { OperationSchema, ServiceDefinition } from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const ID = "Abcd1234Efgh";
const LEAK = "redis-connection-refused-secret-host.internal:6379";

function op(name: string, risk: OperationSchema["risk"], riskReason: string): OperationSchema {
  return {
    name,
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: `urn:${name}`,
    targetNamespace: "urn:test",
    inputElementName: name,
    outputElementName: `${name}Response`,
    endpointAddress: "https://example.com/svc",
    elementFormDefault: "qualified",
    inputDescriptor: [],
    outputDescriptor: [],
    warnings: [],
    risk,
    riskReason,
    riskSource: "heuristic",
    documentation: "docs",
  };
}

function definition(hash: string): ServiceDefinition {
  return {
    name: "Bank",
    wsdlUrl: "https://example.com/bank?wsdl",
    ports: [
      { name: "PortA", address: "https://example.com/svc", operations: [op("GetBalance", "read", "Name starts with Get")] },
      { name: "PortB", address: "https://example.com/svc", operations: [op("CloseAccount", "destructive", "Name starts with Close")] },
    ],
    warnings: [],
    ownerTokenHash: hash,
  };
}

function setup(): { registry: Registry; redis: ReturnType<typeof createFakeRegistryRedis>; calls: string[] } {
  const redis = createFakeRegistryRedis();
  const inner = createRegistry(redis);
  const calls: string[] = [];
  const registry: Registry = {
    upsertService: (d) => inner.upsertService(d),
    getService: (id) => {
      calls.push(`getService:${id}`);
      return inner.getService(id);
    },
    getRules: (id) => {
      calls.push(`getRules:${id}`);
      return inner.getRules(id);
    },
    putRules: (id, r) => {
      calls.push(`putRules:${id}`);
      return inner.putRules(id, r);
    },
    getSettings: (id) => {
      calls.push(`getSettings:${id}`);
      return inner.getSettings(id);
    },
    putSettings: (id, s) => {
      calls.push(`putSettings:${id}`);
      return inner.putSettings(id, s);
    },
  };
  return { registry, redis, calls };
}

async function seed(redis: ReturnType<typeof createFakeRegistryRedis>, def: ServiceDefinition): Promise<void> {
  redis.store.set(`service:${ID}`, JSON.stringify({ ...def, id: ID }));
}

describe("GET service summary", () => {
  it("returns the public summary with risk per operation and no owner data", async () => {
    const { registry, redis } = setup();
    const { token, hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    await registry.putRules(ID, [{ id: "r1", operation: "CloseAccount", effect: "block", reason: "never" }]);
    await registry.putSettings(ID, { ghost: true });

    const res = await getServiceSummary({ registry }, ID);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as ServiceSummary;

    expect(body).toEqual({
      id: ID,
      name: "Bank",
      ghost: true,
      isDemo: false,
      rules: [{ id: "r1", operation: "CloseAccount", effect: "block", reason: "never" }],
      operations: [
        { name: "GetBalance", port: "PortA", risk: "read", riskReason: "Name starts with Get", riskSource: "heuristic" },
        { name: "CloseAccount", port: "PortB", risk: "destructive", riskReason: "Name starts with Close", riskSource: "heuristic" },
      ],
    });
    expect(text).not.toContain(hash);
    expect(text).not.toContain(token);
    expect(text).not.toContain("ownerTokenHash");
  });

  it("defaults to ghost false and no rules", async () => {
    const { registry, redis } = setup();
    await seed(redis, definition("a".repeat(64)));
    const body = (await (await getServiceSummary({ registry }, ID)).json()) as ServiceSummary;
    expect(body.ghost).toBe(false);
    expect(body.rules).toEqual([]);
  });

  it("returns 404 for an unknown service", async () => {
    const { registry } = setup();
    const res = await getServiceSummary({ registry }, "Zzzz9999Yyyy");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found.", code: "NOT_FOUND" });
  });

  it("returns 404 for a malformed id without any registry call", async () => {
    const { registry, calls } = setup();
    for (const bad of ["short", "has space!", "../etc/passwd", "a".repeat(13), ""]) {
      const res = await getServiceSummary({ registry }, bad);
      expect(res.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("maps an ok:false registry result to 503 without internal text", async () => {
    const { registry, redis } = setup();
    redis.failWith = new Error(LEAK);
    const res = await getServiceSummary({ registry }, ID);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
    expect(text).not.toContain("redis");
  });

  it("maps a throwing registry to 503 without internal text", async () => {
    const { registry } = setup();
    const throwing: Registry = {
      ...registry,
      getService: () => Promise.reject(new Error(LEAK)),
    };
    const res = await getServiceSummary({ registry: throwing }, ID);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(LEAK);
  });

  it("returns 503 when rules are corrupt", async () => {
    const { registry, redis } = setup();
    await seed(redis, definition("a".repeat(64)));
    redis.store.set(`rules:${ID}`, "{not json");
    const res = await getServiceSummary({ registry }, ID);
    expect(res.status).toBe(503);
  });
});

describe("shared helpers", () => {
  it("requireOwner gives the identical 401 for missing, malformed and wrong tokens", async () => {
    const { token, hash } = await generateOwnerToken();
    const other = await generateOwnerToken();
    const svc = definition(hash);
    const mk = (value?: string): Request =>
      new Request("http://localhost/x", { headers: value === undefined ? {} : { "x-lazarus-owner": value } });

    const bodies: string[] = [];
    for (const v of [undefined, "", "x".repeat(1000), other.token]) {
      const res = await requireOwner(svc, mk(v));
      expect(res?.status).toBe(401);
      bodies.push((await res?.text()) ?? "");
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Owner token required.", code: "UNAUTHORIZED" });
    expect(await requireOwner(svc, mk(token))).toBeNull();
  });

  it("guarded maps a throw to the fixed 503", async () => {
    const res = await guarded(() => Promise.reject(new Error(LEAK)));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(LEAK);
  });

  it("readJsonBody parses JSON, rejects bad JSON and enforces the byte cap", async () => {
    const mk = (body: string): Request => new Request("http://localhost/x", { method: "POST", body });
    const good = await readJsonBody(mk('[{"a":1}]'));
    expect(good).toEqual({ ok: true, value: [{ a: 1 }] });

    const bad = await readJsonBody(mk("{oops"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.response.status).toBe(400);

    const big = await readJsonBody(mk(JSON.stringify("x".repeat(100))), 50);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.response.status).toBe(413);
  });

  it("isApprovalId accepts only 1-64 safe characters", () => {
    expect(isApprovalId("abc_DEF-123")).toBe(true);
    expect(isApprovalId("")).toBe(false);
    expect(isApprovalId("a".repeat(65))).toBe(false);
    expect(isApprovalId("a/b")).toBe(false);
  });
});

const goodRule = { id: "r1", operation: "CloseAccount", effect: "block", reason: "never" };

type Endpoint = {
  label: string;
  call: (registry: Registry, id: string, request: Request) => Promise<Response>;
  method: "PUT" | "PATCH";
  validBody: unknown;
  oversized: string;
};

const endpoints: Endpoint[] = [
  {
    label: "PUT rules",
    call: (registry, id, request) => putServiceRules({ registry }, id, request),
    method: "PUT",
    validBody: [goodRule],
    oversized: JSON.stringify([{ ...goodRule, reason: "x".repeat(40 * 1024) }]),
  },
  {
    label: "PATCH settings",
    call: (registry, id, request) => patchServiceSettings({ registry }, id, request),
    method: "PATCH",
    validBody: { ghost: true },
    oversized: JSON.stringify({ ghost: true, pad: "x".repeat(5 * 1024) }),
  },
];

function req(method: string, body: string, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-lazarus-owner"] = token;
  return new Request("http://localhost/x", { method, body, headers });
}

describe.each(endpoints)("$label (shared behaviour)", (ep) => {
  it("returns 404 for an unknown service", async () => {
    const { registry } = setup();
    const res = await ep.call(registry, "Zzzz9999Yyyy", req(ep.method, JSON.stringify(ep.validBody), "t"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found.", code: "NOT_FOUND" });
  });

  it("returns 404 for a malformed id with zero registry calls", async () => {
    const { registry, calls } = setup();
    for (const bad of ["short", "has space!", "../etc/passwd", "a".repeat(13), ""]) {
      const res = await ep.call(registry, bad, req(ep.method, JSON.stringify(ep.validBody), "t"));
      expect(res.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("returns 503 without leaked text when the registry is down", async () => {
    const { registry, redis } = setup();
    redis.failWith = new Error(LEAK);
    const res = await ep.call(registry, ID, req(ep.method, JSON.stringify(ep.validBody), "t"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
    expect(text).not.toContain("redis");
  });

  it("returns 503 when the registry throws or fails while saving", async () => {
    const { registry, redis } = setup();
    const { token, hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    const broken: Registry = {
      ...registry,
      putRules: () => Promise.reject(new Error(LEAK)),
      putSettings: () => Promise.resolve({ ok: false, error: { code: "REGISTRY_UNAVAILABLE", message: LEAK } }),
    };
    const res = await ep.call(broken, ID, req(ep.method, JSON.stringify(ep.validBody), token));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
    expect(text).not.toContain(LEAK);
  });

  it("gives the identical 401 for missing, wrong and malformed tokens and writes nothing", async () => {
    const { registry, redis, calls } = setup();
    const { token, hash } = await generateOwnerToken();
    const other = await generateOwnerToken();
    await seed(redis, definition(hash));
    const bodies: string[] = [];
    for (const t of [undefined, "", "x".repeat(1000), other.token]) {
      const res = await ep.call(registry, ID, req(ep.method, JSON.stringify(ep.validBody), t));
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Owner token required.", code: "UNAUTHORIZED" });
    expect(bodies[0]).not.toContain(token);
    expect(calls.some((c) => c.startsWith("put"))).toBe(false);
  });

  it("checks auth before reading the body", async () => {
    const { registry, redis } = setup();
    const { hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    const res = await ep.call(registry, ID, req(ep.method, ep.oversized));
    expect(res.status).toBe(401);
  });

  it("returns 413 for an oversized body and 400 for invalid JSON", async () => {
    const { registry, redis } = setup();
    const { token, hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    const big = await ep.call(registry, ID, req(ep.method, ep.oversized, token));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe("TOO_LARGE");
    const bad = await ep.call(registry, ID, req(ep.method, "{oops", token));
    expect(bad.status).toBe(400);
  });
});

describe("PUT rules", () => {
  async function ready(): Promise<{ registry: Registry; token: string }> {
    const { registry, redis } = setup();
    const { token, hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    return { registry, token };
  }

  it("saves valid rules, returns them, and the summary shows them", async () => {
    const { registry, token } = await ready();
    const res = await putServiceRules({ registry }, ID, req("PUT", JSON.stringify([goodRule]), token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([goodRule]);
    const summary = (await (await getServiceSummary({ registry }, ID)).json()) as ServiceSummary;
    expect(summary.rules).toEqual([goodRule]);
  });

  it("accepts exactly 25 rules and rejects 26 with 400", async () => {
    const { registry, token } = await ready();
    const mk = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ ...goodRule, id: `r${i}` }));
    const ok = await putServiceRules({ registry }, ID, req("PUT", JSON.stringify(mk(25)), token));
    expect(ok.status).toBe(200);
    const res = await putServiceRules({ registry }, ID, req("PUT", JSON.stringify(mk(26)), token));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.error.length).toBeLessThanOrEqual(500);
    expect(body.error).toContain("Invalid rules");
  });

  it("rejects duplicate rule ids with 400 and keeps the old rules", async () => {
    const { registry, token } = await ready();
    await putServiceRules({ registry }, ID, req("PUT", JSON.stringify([goodRule]), token));
    const res = await putServiceRules(
      { registry },
      ID,
      req("PUT", JSON.stringify([goodRule, { ...goodRule, operation: "Other" }]), token),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Duplicate rule id: r1");
    const summary = (await (await getServiceSummary({ registry }, ID)).json()) as ServiceSummary;
    expect(summary.rules).toEqual([goodRule]);
  });

  it("rejects an invalid condition op with 400 naming the field", async () => {
    const { registry, token } = await ready();
    const bad = [{ ...goodRule, when: { field: "amount", op: "bigger", value: 5 } }];
    const res = await putServiceRules({ registry }, ID, req("PUT", JSON.stringify(bad), token));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("0.when.op");
    expect(body.error.length).toBeLessThanOrEqual(500);
  });

  it("rejects a wrapped object body with 400", async () => {
    const { registry, token } = await ready();
    const res = await putServiceRules({ registry }, ID, req("PUT", JSON.stringify({ rules: [goodRule] }), token));
    expect(res.status).toBe(400);
  });

  it("accepts an empty array to clear the rules", async () => {
    const { registry, token } = await ready();
    await putServiceRules({ registry }, ID, req("PUT", JSON.stringify([goodRule]), token));
    const res = await putServiceRules({ registry }, ID, req("PUT", "[]", token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("PATCH settings", () => {
  async function ready(): Promise<{ registry: Registry; token: string }> {
    const { registry, redis } = setup();
    const { token, hash } = await generateOwnerToken();
    await seed(redis, definition(hash));
    return { registry, token };
  }

  it("toggles ghost on and off and the summary reflects it", async () => {
    const { registry, token } = await ready();
    for (const ghost of [true, false, true]) {
      const res = await patchServiceSettings({ registry }, ID, req("PATCH", JSON.stringify({ ghost }), token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ghost });
      const summary = (await (await getServiceSummary({ registry }, ID)).json()) as ServiceSummary;
      expect(summary.ghost).toBe(ghost);
    }
  });

  it("rejects extra keys with 400 and changes nothing", async () => {
    const { registry, token } = await ready();
    const res = await patchServiceSettings({ registry }, ID, req("PATCH", JSON.stringify({ ghost: true, admin: 1 }), token));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_REQUEST");
    const summary = (await (await getServiceSummary({ registry }, ID)).json()) as ServiceSummary;
    expect(summary.ghost).toBe(false);
  });

  it("rejects non-boolean ghost, missing ghost and non-object bodies with 400", async () => {
    const { registry, token } = await ready();
    for (const body of [{ ghost: "true" }, { ghost: 1 }, { ghost: null }, {}, [], "x", null]) {
      const res = await patchServiceSettings({ registry }, ID, req("PATCH", JSON.stringify(body), token));
      expect(res.status).toBe(400);
    }
  });
});

// ─── approvals: GET list and POST resolve ────────────────────────────────────

const DEMO_HOST = "gravewood.test";
const AID_BAD = ["a/b", "a b", "x".repeat(65), "..", "a%2Fb", "a.b"];

describe("approvals endpoints", () => {
  const savedHost = process.env.LAZARUS_GRAVEWOOD_HOST;
  beforeEach(() => {
    process.env.LAZARUS_GRAVEWOOD_HOST = DEMO_HOST;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.LAZARUS_GRAVEWOOD_HOST;
    else process.env.LAZARUS_GRAVEWOOD_HOST = savedHost;
    vi.restoreAllMocks();
  });

  function approvalsSetup() {
    const base = setup();
    let clock = Date.parse("2026-01-01T12:00:00Z");
    const rate = createFakeRateRedis(() => clock);
    const approvals = createApprovals(createFakeApprovalsRedis(), { now: () => clock });
    const deps: ApprovalsDeps = { registry: base.registry, approvals, rateRedis: rate };
    return {
      ...base,
      rate,
      approvals,
      deps,
      advance: (ms: number): void => {
        clock += ms;
      },
    };
  }
  type H = ReturnType<typeof approvalsSetup>;

  async function seedPrivate(h: H): Promise<{ token: string }> {
    const { token, hash } = await generateOwnerToken();
    await seed(h.redis, definition(hash));
    return { token };
  }
  async function seedDemo(h: H): Promise<void> {
    const { hash } = await generateOwnerToken();
    await seed(h.redis, { ...definition(hash), wsdlUrl: `https://${DEMO_HOST}/api/gravewood/abc/wsdl` });
  }
  function hold(h: H, args: unknown = { accountId: "4471" }, tool = "CloseAccount"): Promise<Approval> {
    return h.approvals.createApproval(ID, { serviceId: ID, tool, args, risk: "destructive", reason: "Destructive operation" });
  }
  function getReq(token?: string): Request {
    return new Request("http://localhost/x", { headers: token === undefined ? {} : { "x-lazarus-owner": token } });
  }
  function postReq(body: unknown, opts: { token?: string; ip?: string } = {}): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token !== undefined) headers["x-lazarus-owner"] = opts.token;
    if (opts.ip !== undefined) headers["x-forwarded-for"] = opts.ip;
    return new Request("http://localhost/x", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  const resolve = (h: H, aid: string, body: unknown, opts: { token?: string; ip?: string } = {}): Promise<Response> =>
    resolveServiceApproval(h.deps, ID, aid, postReq(body, opts));

  describe.each([
    {
      label: "GET approvals",
      call: (h: H, id: string): Promise<Response> => listServiceApprovals(h.deps, id, getReq("t")),
    },
    {
      label: "POST approval",
      call: (h: H, id: string): Promise<Response> =>
        resolveServiceApproval(h.deps, id, "aid-1", postReq({ decision: "approve" }, { token: "t" })),
    },
  ])("$label (shared behaviour)", ({ call }) => {
    it("returns 404 for an unknown service", async () => {
      const h = approvalsSetup();
      const res = await call(h, "Zzzz9999Yyyy");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Service not found.", code: "NOT_FOUND" });
    });

    it("returns 404 for a malformed service id with zero registry calls", async () => {
      const h = approvalsSetup();
      for (const bad of ["short", "has space!", "../etc/passwd", "a".repeat(13), ""]) {
        expect((await call(h, bad)).status).toBe(404);
      }
      expect(h.calls).toEqual([]);
    });

    it("returns 503 without leaked text when the registry is down", async () => {
      const h = approvalsSetup();
      h.redis.failWith = new Error(LEAK);
      const res = await call(h, ID);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
      expect(text).not.toContain("redis");
      expect(text).not.toContain(LEAK);
    });
  });

  it("POST returns 404 for a malformed approval id with zero registry calls", async () => {
    const h = approvalsSetup();
    await seedDemo(h);
    for (const bad of AID_BAD) {
      const res = await resolve(h, bad, { decision: "approve" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
    }
    expect(h.calls).toEqual([]);
  });

  describe("GET list", () => {
    it("returns newest first, capped at 50", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      for (let i = 0; i < 52; i++) await hold(h, { n: i }, `Tool${i}`);
      const res = await listServiceApprovals(h.deps, ID, getReq());
      expect(res.status).toBe(200);
      const list = (await res.json()) as ApprovalView[];
      expect(list).toHaveLength(50);
      expect(list[0].tool).toBe("Tool51");
      expect(list[49].tool).toBe("Tool2");
    });

    it("returns redacted args while the stored approval keeps the raw args", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h, { accountId: "4471", password: "hunter2", nested: { apiKey: "sk-live-123" } });
      const res = await listServiceApprovals(h.deps, ID, getReq());
      const text = await res.text();
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("sk-live-123");
      const [view] = JSON.parse(text) as ApprovalView[];
      expect(view.args).toEqual({ accountId: "4471", password: "[redacted]", nested: { apiKey: "[redacted]" } });
      expect(view.id).toBe(a.id);
      const stored = await h.approvals.getApproval(ID, a.id);
      expect(stored?.args).toEqual({ accountId: "4471", password: "hunter2", nested: { apiKey: "sk-live-123" } });
    });

    it("is public for the demo service", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      await hold(h);
      const res = await listServiceApprovals(h.deps, ID, getReq());
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    });

    it("requires the owner token for a non-demo service (identical 401 for none, wrong, malformed)", async () => {
      const h = approvalsSetup();
      const { token } = await seedPrivate(h);
      const other = await generateOwnerToken();
      await hold(h);
      const bodies: string[] = [];
      for (const t of [undefined, "", "x".repeat(1000), other.token]) {
        const res = await listServiceApprovals(h.deps, ID, getReq(t));
        expect(res.status).toBe(401);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toEqual({ error: "Owner token required.", code: "UNAUTHORIZED" });
      const ok = await listServiceApprovals(h.deps, ID, getReq(token));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveLength(1);
    });

    it("returns 503 without leaked text when the approval store throws", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const broken: Pick<Approvals, "listApprovals" | "getApproval" | "resolveApproval"> = {
        ...h.approvals,
        listApprovals: () => Promise.reject(new Error(LEAK)),
      };
      const res = await listServiceApprovals({ ...h.deps, approvals: broken }, ID, getReq());
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
      expect(text).not.toContain(LEAK);
    });
  });

  describe("POST resolve", () => {
    it("approves, returns the updated approval with redacted args", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h, { accountId: "4471", password: "hunter2" });
      const res = await resolve(h, a.id, { decision: "approve" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("hunter2");
      const body = JSON.parse(text) as ApprovalView;
      expect(body).toMatchObject({ id: a.id, status: "approved", tool: "CloseAccount" });
      expect(body.args).toEqual({ accountId: "4471", password: "[redacted]" });
      expect(typeof body.resolvedAt).toBe("string");
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("approved");
    });

    it("denies with a note", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const res = await resolve(h, a.id, { decision: "deny", note: "Not today" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "denied", note: "Not today" });
    });

    it("returns 409 on a second approve and on deny after approve, leaving the first decision", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      expect((await resolve(h, a.id, { decision: "approve" })).status).toBe(200);
      for (const decision of ["approve", "deny"]) {
        const res = await resolve(h, a.id, { decision });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "This approval is no longer pending.", code: "CONFLICT" });
      }
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("approved");
    });

    it("returns 409 for an expired approval", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      h.advance(16 * 60 * 1000);
      const res = await resolve(h, a.id, { decision: "approve" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("CONFLICT");
    });

    it("returns 404 for an unknown approval id", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const res = await resolve(h, "doesNotExist123", { decision: "approve" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Approval not found.", code: "NOT_FOUND" });
    });

    it("rejects a wrong or missing decision, a long note, extra keys and non-objects with 400", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const bad: unknown[] = [
        { decision: "maybe" },
        { decision: "APPROVE" },
        {},
        { note: "x" },
        { decision: "approve", note: "n".repeat(201) },
        { decision: "approve", note: 5 },
        { decision: "approve", extra: true },
        [],
        "approve",
        null,
      ];
      for (const body of bad) {
        const res = await resolve(h, a.id, body);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("INVALID_REQUEST");
      }
      expect((await resolve(h, a.id, "{oops")).status).toBe(400);
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("pending");
    });

    it("accepts a note of exactly 200 characters", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const res = await resolve(h, a.id, { decision: "deny", note: "n".repeat(200) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ApprovalView).note).toBe("n".repeat(200));
    });

    it("returns 413 for a body over 4 KB", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const res = await resolve(h, a.id, { decision: "approve", pad: "x".repeat(5 * 1024) });
      expect(res.status).toBe(413);
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("pending");
    });

    it("sanitises the note before storing it", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const res = await resolve(h, a.id, { decision: "deny", note: "  Looks\u200b  odd\n\tto   me\u202e " });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ApprovalView).note).toBe("Looks odd to me");
      expect((await h.approvals.getApproval(ID, a.id))?.note).toBe("Looks odd to me");
    });

    it("stores no note when the note sanitises to nothing", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const res = await resolve(h, a.id, { decision: "approve", note: "\u200b \n" });
      expect(res.status).toBe(200);
      expect((await h.approvals.getApproval(ID, a.id))?.note).toBeUndefined();
    });

    it("needs no token for the demo service", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      expect((await resolve(h, a.id, { decision: "approve" })).status).toBe(200);
    });

    it("requires the owner token for a non-demo service: identical 401, nothing changes, right token works", async () => {
      const h = approvalsSetup();
      const { token } = await seedPrivate(h);
      const other = await generateOwnerToken();
      const a = await hold(h);
      const bodies: string[] = [];
      for (const t of [undefined, "", "x".repeat(1000), other.token]) {
        const res = await resolve(h, a.id, { decision: "approve" }, { token: t });
        expect(res.status).toBe(401);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toEqual({ error: "Owner token required.", code: "UNAUTHORIZED" });
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("pending");

      const ok = await resolve(h, a.id, { decision: "approve" }, { token });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as ApprovalView).status).toBe("approved");
    });

    it("checks the owner token before reading the body", async () => {
      const h = approvalsSetup();
      await seedPrivate(h);
      const res = await resolve(h, "aid-1", "x".repeat(10 * 1024));
      expect(res.status).toBe(401);
    });

    it("rate limits to 30 per minute per client IP: the 31st is 429", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 31; i++) {
        last = await resolve(h, a.id, { decision: "approve" }, { ip: "198.51.100.7" });
        statuses.push(last.status);
      }
      expect(statuses[0]).toBe(200);
      expect(statuses.slice(1, 30).every((s) => s === 409)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(await last?.json()).toEqual({ error: "Too many requests. Try again shortly.", code: "RATE_LIMITED" });

      // Another IP is counted separately; the window reopens after a minute.
      const other = await resolve(h, a.id, { decision: "approve" }, { ip: "198.51.100.8" });
      expect(other.status).toBe(409);
      h.advance(61_000);
      const again = await resolve(h, a.id, { decision: "approve" }, { ip: "198.51.100.7" });
      expect(again.status).toBe(409);
    });

    it("fails closed with 503 when the rate limiter is down, and does not resolve", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      h.rate.failWith = new Error(LEAK);
      const res = await resolve(h, a.id, { decision: "approve" });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
      expect(text).not.toContain(LEAK);
      expect((await h.approvals.getApproval(ID, a.id))?.status).toBe("pending");
    });

    it("returns 503 without leaked text when the approval store throws or the approval vanishes", async () => {
      const h = approvalsSetup();
      await seedDemo(h);
      const a = await hold(h);
      const throwing: Pick<Approvals, "listApprovals" | "getApproval" | "resolveApproval"> = {
        ...h.approvals,
        resolveApproval: () => Promise.reject(new Error(LEAK)),
      };
      const res = await resolveServiceApproval(
        { ...h.deps, approvals: throwing },
        ID,
        a.id,
        postReq({ decision: "approve" }),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(LEAK);

      const vanishing: Pick<Approvals, "listApprovals" | "getApproval" | "resolveApproval"> = {
        ...h.approvals,
        getApproval: () => Promise.resolve(null),
      };
      const res2 = await resolveServiceApproval(
        { ...h.deps, approvals: vanishing },
        ID,
        a.id,
        postReq({ decision: "approve" }),
      );
      expect(res2.status).toBe(503);
    });
  });

  describe("clientIpOf", () => {
    const withHeaders = (headers: Record<string, string>): Request => new Request("http://localhost/x", { headers });
    it("uses the first x-forwarded-for entry, then x-real-ip, then a fallback", () => {
      expect(clientIpOf(withHeaders({ "x-forwarded-for": "203.0.113.5, 10.0.0.1", "x-real-ip": "9.9.9.9" }))).toBe("203.0.113.5");
      expect(clientIpOf(withHeaders({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
      expect(clientIpOf(withHeaders({}))).toBe("unknown");
      expect(clientIpOf(withHeaders({ "x-forwarded-for": " , 1.2.3.4" }))).toBe("unknown");
    });
    it("bounds the length and strips key separators", () => {
      const ip = clientIpOf(withHeaders({ "x-forwarded-for": `1.2.3.4:x*${"z".repeat(500)}` }));
      expect(ip.length).toBeLessThanOrEqual(64);
      expect(ip).toMatch(/^[A-Za-z0-9.:_-]+$/);
    });
  });
});

describe("approvals integration: gateway hold, API resolve, check_approval executes once", () => {
  const savedHost = process.env.LAZARUS_GRAVEWOOD_HOST;
  beforeEach(() => {
    process.env.LAZARUS_GRAVEWOOD_HOST = DEMO_HOST;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.LAZARUS_GRAVEWOOD_HOST;
    else process.env.LAZARUS_GRAVEWOOD_HOST = savedHost;
    vi.restoreAllMocks();
  });

  it("holds CloseAccount, a demo visitor approves with no token, check_approval runs it once", async () => {
    const parsed = await parseWsdl(readFileSync("fixtures/gravewood.wsdl", "utf8"), {
      fetch: (url: string): never => {
        throw new Error(`network fetch attempted: ${url}`);
      },
    });
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message}`);
    const service: ServiceDefinition = {
      ...parsed.definition,
      wsdlUrl: `https://${DEMO_HOST}/api/gravewood/abc/wsdl`,
      id: ID,
    };
    const tools = buildTools(service);
    const close = tools.find((t) => t.name === "CloseAccount");
    if (!close) throw new Error("CloseAccount tool missing");

    const registryRedis = createFakeRegistryRedis();
    registryRedis.store.set(`service:${ID}`, JSON.stringify(service));
    const registry = createRegistry(registryRedis);
    let clock = Date.parse("2026-01-01T12:00:00Z");
    const rateRedis = createFakeRateRedis(() => clock);
    const approvals = createApprovals(createFakeApprovalsRedis(), { now: () => clock });

    let bank = seedState();
    const upstream: string[] = [];
    const post: typeof safePost = async (_url, req) => {
      upstream.push(req.body);
      const r = handleSoap(bank, req.headers.SOAPAction ?? null, req.body, "2026-01-01T12:00:00Z");
      bank = r.state;
      return { ok: true, status: r.status, body: r.xml };
    };
    const pipeline = createPipeline({
      registry,
      transcripts: createTranscripts(createFakeTranscriptRedis()),
      approvals,
      post,
      rateRedis,
      now: () => clock++,
      sleep: async (ms) => {
        clock += ms;
      },
      newId: () => "id",
    });
    const deps: ApprovalsDeps = { registry, approvals, rateRedis };
    const status = (): string | undefined => bank.accounts.find((x) => x.id === "4471")?.status;
    const textOf = (r: { content: [{ type: "text"; text: string }] }): string => r.content[0].text;

    const held = await pipeline.runCall({ service, tool: close, args: { accountId: "4471" }, clientIp: "203.0.113.9" });
    expect(held.structuredContent?.status).toBe("held");
    expect(upstream).toHaveLength(0);
    expect(status()).toBe("OPEN");

    const listed = (await (await listServiceApprovals(deps, ID, new Request("http://localhost/x"))).json()) as ApprovalView[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tool: "CloseAccount", status: "pending", args: { accountId: "4471" } });
    const approvalId = listed[0].id;
    expect(held.structuredContent?.approvalId).toBe(approvalId);

    const resolved = await resolveServiceApproval(
      deps,
      ID,
      approvalId,
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
    expect(resolved.status).toBe(200);
    expect(upstream).toHaveLength(0);

    const first = await pipeline.runCheckApproval({ service, tools, approvalId, clientIp: "203.0.113.9" });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({ closed: true });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toContain("4471");
    expect(status()).toBe("CLOSED");

    const second = await pipeline.runCheckApproval({ service, tools, approvalId, clientIp: "203.0.113.9" });
    expect(second.isError).toBeUndefined();
    expect(textOf(second)).toBe("This call was already executed.");
    expect(upstream).toHaveLength(1);

    const after = (await (await listServiceApprovals(deps, ID, new Request("http://localhost/x"))).json()) as ApprovalView[];
    expect(after[0].status).toBe("executed");
  });
});

// ─── transcripts: GET list ───────────────────────────────────────────────────

describe("GET transcripts", () => {
  const savedHost = process.env.LAZARUS_GRAVEWOOD_HOST;
  beforeEach(() => {
    process.env.LAZARUS_GRAVEWOOD_HOST = DEMO_HOST;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (savedHost === undefined) delete process.env.LAZARUS_GRAVEWOOD_HOST;
    else process.env.LAZARUS_GRAVEWOOD_HOST = savedHost;
    vi.restoreAllMocks();
  });

  function tSetup() {
    const base = setup();
    const tredis = createFakeTranscriptRedis();
    const transcripts = createTranscripts(tredis);
    return { ...base, tredis, transcripts, deps: { registry: base.registry, transcripts } };
  }
  type T = ReturnType<typeof tSetup>;

  function entry(n: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return {
      id: `e${n}`,
      ts: new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString(),
      tool: "GetBalance",
      args: { accountId: "4471" },
      risk: "read",
      decision: "allow",
      outcome: "ok",
      durationMs: 5,
      summary: "ok",
      ...extra,
    };
  }
  async function seedPrivate(t: T): Promise<{ token: string; hash: string }> {
    const { token, hash } = await generateOwnerToken();
    await seed(t.redis, definition(hash));
    return { token, hash };
  }
  async function seedDemo(t: T): Promise<void> {
    const { hash } = await generateOwnerToken();
    await seed(t.redis, { ...definition(hash), wsdlUrl: `https://${DEMO_HOST}/api/gravewood/abc/wsdl` });
  }
  function get(query = "", token?: string): Request {
    return new Request(`http://localhost/x${query}`, {
      headers: token === undefined ? {} : { "x-lazarus-owner": token },
    });
  }
  const ids = (list: TranscriptEntry[]): string[] => list.map((e) => e.id);

  it("returns 404 for an unknown service", async () => {
    const t = tSetup();
    const res = await listServiceTranscripts(t.deps, "Zzzz9999Yyyy", get("", "t"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found.", code: "NOT_FOUND" });
  });

  it("returns 404 for a malformed id with zero registry calls", async () => {
    const t = tSetup();
    for (const bad of ["short", "has space!", "../etc/passwd", "a".repeat(13), ""]) {
      expect((await listServiceTranscripts(t.deps, bad, get("?since=nonsense", "t"))).status).toBe(404);
    }
    expect(t.calls).toEqual([]);
  });

  it("returns 503 without leaked text when the registry is down or throws", async () => {
    const t = tSetup();
    t.redis.failWith = new Error(LEAK);
    const down = await listServiceTranscripts(t.deps, ID, get());
    expect(down.status).toBe(503);
    const text = await down.text();
    expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
    expect(text).not.toContain("redis");

    const throwing = { ...t.deps, registry: { getService: () => Promise.reject(new Error(LEAK)) } };
    const res = await listServiceTranscripts(throwing, ID, get());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(LEAK);
  });

  it("returns 503 without leaked text when the transcript store fails", async () => {
    const t = tSetup();
    await seedDemo(t);
    t.tredis.failWith = new Error(LEAK);
    const res = await listServiceTranscripts(t.deps, ID, get());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The registry is temporarily unavailable.", code: "UNAVAILABLE" });
    expect(text).not.toContain(LEAK);
  });

  it("returns newest first", async () => {
    const t = tSetup();
    await seedDemo(t);
    for (const n of [1, 2, 3]) await t.transcripts.appendTranscript(ID, entry(n));
    const res = await listServiceTranscripts(t.deps, ID, get());
    expect(res.status).toBe(200);
    expect(ids((await res.json()) as TranscriptEntry[])).toEqual(["e3", "e2", "e1"]);
  });

  it("returns at most 100 entries", async () => {
    const t = tSetup();
    await seedDemo(t);
    for (let n = 0; n < 120; n++) await t.transcripts.appendTranscript(ID, entry(n));
    const list = (await (await listServiceTranscripts(t.deps, ID, get())).json()) as TranscriptEntry[];
    expect(list).toHaveLength(100);
    expect(list[0].id).toBe("e119");
  });

  it("since is exclusive: entries at or before it are dropped", async () => {
    const t = tSetup();
    await seedDemo(t);
    for (const n of [1, 2, 3, 4]) await t.transcripts.appendTranscript(ID, entry(n));
    const at = encodeURIComponent(entry(2).ts);
    const list = (await (await listServiceTranscripts(t.deps, ID, get(`?since=${at}`))).json()) as TranscriptEntry[];
    expect(ids(list)).toEqual(["e4", "e3"]);

    const none = (await (await listServiceTranscripts(t.deps, ID, get(`?since=${encodeURIComponent(entry(4).ts)}`))).json()) as TranscriptEntry[];
    expect(none).toEqual([]);
  });

  it("accepts a date-only since", async () => {
    const t = tSetup();
    await seedDemo(t);
    await t.transcripts.appendTranscript(ID, entry(1, { ts: "2025-12-31T23:59:59.000Z" }));
    await t.transcripts.appendTranscript(ID, entry(2));
    const res = await listServiceTranscripts(t.deps, ID, get("?since=2026-01-01"));
    expect(res.status).toBe(200);
    expect(ids((await res.json()) as TranscriptEntry[])).toEqual(["e2"]);
  });

  it("returns 400 with a fixed body for an unparseable since", async () => {
    const t = tSetup();
    await seedDemo(t);
    const bad = ["", "yesterday", "1", "2020", "2026-13-45", "2026-02-30T99:99:99Z", "nope%00", "x".repeat(500), "2026-01-01T00:00:00Z junk"];
    for (const value of bad) {
      const res = await listServiceTranscripts(t.deps, ID, get(`?since=${encodeURIComponent(value)}`));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "since must be an ISO 8601 date.", code: "INVALID_REQUEST" });
      expect(text).not.toContain("junk");
    }
  });

  it("redacts stored entries again on read", async () => {
    const t = tSetup();
    await seedDemo(t);
    const dirty = {
      ...entry(1),
      args: { accountId: "4471", password: "hunter2", nested: { apiKey: "sk-live-123" } },
      soapRequest: "<Login><password>hunter2</password><user>bob</user></Login>",
    };
    t.tredis.lists.set(`transcripts:${ID}`, [JSON.stringify(dirty)]);
    const res = await listServiceTranscripts(t.deps, ID, get());
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-live-123");
    const [e] = JSON.parse(text) as TranscriptEntry[];
    expect(e.args).toEqual({ accountId: "4471", password: "[redacted]", nested: { apiKey: "[redacted]" } });
    expect(e.soapRequest).toContain("[redacted]");
    expect(e.soapRequest).toContain("bob");
  });

  it("redacts even when the injected store returns raw entries", async () => {
    const t = tSetup();
    await seedDemo(t);
    const raw: TranscriptEntry = { ...entry(1), args: { token: "abc123secret" } };
    const deps = { registry: t.registry, transcripts: { listTranscripts: () => Promise.resolve([raw]) } };
    const text = await (await listServiceTranscripts(deps, ID, get())).text();
    expect(text).not.toContain("abc123secret");
    expect((JSON.parse(text) as TranscriptEntry[])[0].args).toEqual({ token: "[redacted]" });
  });

  it("is public for the demo service", async () => {
    const t = tSetup();
    await seedDemo(t);
    await t.transcripts.appendTranscript(ID, entry(1));
    const res = await listServiceTranscripts(t.deps, ID, get());
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("requires the owner token for a non-demo service (identical 401 for none, wrong, malformed)", async () => {
    const t = tSetup();
    const { token, hash } = await seedPrivate(t);
    const other = await generateOwnerToken();
    await t.transcripts.appendTranscript(ID, entry(1));
    const bodies: string[] = [];
    for (const v of [undefined, "", "x".repeat(1000), other.token]) {
      const res = await listServiceTranscripts(t.deps, ID, get("", v));
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Owner token required.", code: "UNAUTHORIZED" });

    const ok = await listServiceTranscripts(t.deps, ID, get("", token));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text)).toHaveLength(1);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hash);
  });

  it("checks auth before since: a bad since without a token is 401, not 400", async () => {
    const t = tSetup();
    await seedPrivate(t);
    const res = await listServiceTranscripts(t.deps, ID, get("?since=nonsense"));
    expect(res.status).toBe(401);
  });

  it("never includes the owner token or its hash", async () => {
    const t = tSetup();
    const { token, hash } = await seedPrivate(t);
    await t.transcripts.appendTranscript(ID, entry(1));
    const text = await (await listServiceTranscripts(t.deps, ID, get("", token))).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(hash);
    expect(text).not.toContain("ownerTokenHash");
  });
});

describe("transcripts route source", () => {
  const src = readFileSync("app/api/services/[id]/transcripts/route.ts", "utf8");
  it("has no runtime export and awaits params", () => {
    expect(src).not.toMatch(/export\s+const\s+runtime/);
    expect(src).toContain("params: Promise<");
    expect(src).toContain("await params");
  });
});
