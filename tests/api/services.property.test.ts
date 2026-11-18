import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getServiceSummary,
  listServiceApprovals,
  listServiceTranscripts,
  patchServiceSettings,
  putServiceRules,
  resolveServiceApproval,
  type ApprovalsDeps,
} from "../../lib/api/services";
import { hashOwnerToken } from "../../lib/owner-token";
import { createRegistry } from "../../lib/registry";
import { createApprovals } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { ServiceDefinition } from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

// Feature: mcp-gateway, Property 24: Owner token never leaks
// **Validates: Requirements 6.4**

const TOKEN = "Kn0wnOwnerTok3n_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456";
const OTHER_TOKEN = "Wr0ngOwnerTok3n_abcdefghijklmnopqrstuvwxyz-9876543";
const DEMO_HOST = "gravewood.test";
const LEAK = "redis-connection-refused-secret-host.internal:6379";
const UNKNOWN_ID = "Zzzz9999Yyyy";
const MALFORMED_ID = "../etc/passwd";

/** True when the text holds the plaintext token or its hash (hex, either case). */
function leaks(text: string, token: string, hash: string): boolean {
  return text.includes(token) || text.includes(hash) || text.toLowerCase().includes(hash.toLowerCase());
}

/** Status, every header entry and the body text of a response, as one string. */
async function serialise(res: Response): Promise<{ status: number; raw: string }> {
  const body = await res.text();
  return { status: res.status, raw: JSON.stringify({ status: res.status, headers: [...res.headers.entries()], body }) };
}

type Svc = "private" | "demo" | "unknown" | "malformed";
type Auth = "right" | "wrong" | "missing" | "empty" | "malformed";
type Fault = "none" | "registry" | "transcripts" | "approvals";
type Kind = "summary" | "putRules" | "patchSettings" | "listApprovals" | "resolve" | "transcripts";
type Action = { kind: Kind; svc: Svc; auth: Auth; fault: Fault; variant: number; aid: number };

const actionArb: fc.Arbitrary<Action> = fc.record({
  kind: fc.constantFrom<Kind>("summary", "putRules", "patchSettings", "listApprovals", "resolve", "transcripts"),
  svc: fc.constantFrom<Svc>("private", "demo", "unknown", "malformed"),
  auth: fc.constantFrom<Auth>("right", "wrong", "missing", "empty", "malformed"),
  fault: fc.constantFrom<Fault>("none", "none", "none", "registry", "transcripts", "approvals"),
  variant: fc.integer({ min: 0, max: 3 }),
  aid: fc.integer({ min: 0, max: 3 }),
});
const sequenceArb = fc.array(actionArb, { minLength: 1, maxLength: 12 });

const RULES_BODIES = [
  JSON.stringify([{ id: "r1", operation: "CloseAccount", effect: "block", reason: "never" }]),
  "{oops",
  JSON.stringify({ rules: [] }),
  "[]",
];
const SETTINGS_BODIES = [JSON.stringify({ ghost: true }), JSON.stringify({ ghost: "yes" }), "{oops", JSON.stringify({ ghost: false })];
const RESOLVE_BODIES = [
  JSON.stringify({ decision: "approve" }),
  JSON.stringify({ decision: "deny", note: "not today" }),
  JSON.stringify({ decision: "maybe" }),
  "{oops",
];
const SINCE = ["", "?since=2020-01-01", "?since=nonsense", "?since=2026-01-01T12:00:00Z"];

function tokenHeader(auth: Auth): string | undefined {
  switch (auth) {
    case "right":
      return TOKEN;
    case "wrong":
      return OTHER_TOKEN;
    case "empty":
      return "";
    case "malformed":
      return "x".repeat(300);
    case "missing":
      return undefined;
  }
}

function request(method: string, auth: Auth, opts: { query?: string; body?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9" };
  const t = tokenHeader(auth);
  if (t !== undefined) headers["x-lazarus-owner"] = t;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost/x${opts.query ?? ""}`, { method, headers, body: opts.body });
}

function definition(name: string, wsdlUrl: string, hash: string): ServiceDefinition {
  return { name, wsdlUrl, ports: [], warnings: [], ownerTokenHash: hash };
}

type Fixture = {
  hash: string;
  ids: Record<Svc, string>;
  approvalIds: string[];
  registryRedis: ReturnType<typeof createFakeRegistryRedis>;
  transcriptRedis: ReturnType<typeof createFakeTranscriptRedis>;
  approvalsRedis: ReturnType<typeof createFakeApprovalsRedis>;
  run: (a: Action) => Promise<Response>;
  /** Everything stored except the service record, which legitimately holds the hash. */
  storedText: () => string;
};

async function buildFixture(): Promise<Fixture> {
  const hash = await hashOwnerToken(TOKEN);
  const registryRedis = createFakeRegistryRedis();
  const registry = createRegistry(registryRedis);
  const transcriptRedis = createFakeTranscriptRedis();
  const transcripts = createTranscripts(transcriptRedis);
  const approvalsRedis = createFakeApprovalsRedis();
  const clock = Date.parse("2026-01-01T12:00:00Z");
  const approvals = createApprovals(approvalsRedis, { now: () => clock });
  const rateRedis = createFakeRateRedis(() => clock);

  const priv = await registry.upsertService(definition("Private", "https://example.com/bank?wsdl", hash));
  const demo = await registry.upsertService(definition("Demo", `https://${DEMO_HOST}/api/gravewood/abc/wsdl`, hash));
  if (!priv.ok || !demo.ok) throw new Error("fixture: service registration failed");
  const ids: Record<Svc, string> = { private: priv.id, demo: demo.id, unknown: UNKNOWN_ID, malformed: MALFORMED_ID };

  const approvalIds: string[] = [];
  for (const id of [priv.id, demo.id]) {
    const a = await approvals.createApproval(id, {
      serviceId: id,
      tool: "CloseAccount",
      args: { accountId: "4471" },
      risk: "destructive",
      reason: "Destructive operation",
    });
    approvalIds.push(a.id);
    await transcripts.appendTranscript(id, {
      id: `t-${id}`,
      ts: "2026-01-01T12:00:01.000Z",
      tool: "GetBalance",
      args: { accountId: "4471" },
      risk: "read",
      decision: "allow",
      outcome: "ok",
      durationMs: 5,
      summary: "ok",
    });
  }

  const throwingApprovals: ApprovalsDeps["approvals"] = {
    listApprovals: () => Promise.reject(new Error(LEAK)),
    getApproval: () => Promise.reject(new Error(LEAK)),
    resolveApproval: () => Promise.reject(new Error(LEAK)),
  };

  async function run(a: Action): Promise<Response> {
    registryRedis.failWith = a.fault === "registry" ? new Error(LEAK) : undefined;
    transcriptRedis.failWith = a.fault === "transcripts" ? new Error(LEAK) : undefined;
    const id = ids[a.svc];
    const regDeps = { registry };
    const apprDeps: ApprovalsDeps = {
      registry,
      approvals: a.fault === "approvals" ? throwingApprovals : approvals,
      rateRedis,
    };
    switch (a.kind) {
      case "summary":
        return getServiceSummary(regDeps, id);
      case "putRules":
        return putServiceRules(regDeps, id, request("PUT", a.auth, { body: RULES_BODIES[a.variant] }));
      case "patchSettings":
        return patchServiceSettings(regDeps, id, request("PATCH", a.auth, { body: SETTINGS_BODIES[a.variant] }));
      case "listApprovals":
        return listServiceApprovals(apprDeps, id, request("GET", a.auth));
      case "resolve": {
        const aid = [...approvalIds, "doesNotExist123", "bad/id"][a.aid];
        return resolveServiceApproval(apprDeps, id, aid, request("POST", a.auth, { body: RESOLVE_BODIES[a.variant] }));
      }
      case "transcripts":
        return listServiceTranscripts({ registry, transcripts }, id, request("GET", a.auth, { query: SINCE[a.variant] }));
    }
  }

  function storedText(): string {
    const registryEntries = [...registryRedis.store.entries()].filter(([key]) => !key.startsWith("service:"));
    const approvalHashes = [...approvalsRedis.hashes.entries()].map(([k, h]) => [k, [...h.entries()]]);
    return JSON.stringify({
      registry: registryEntries,
      transcripts: [...transcriptRedis.lists.entries()],
      approvalHashes,
      approvalLists: [...approvalsRedis.lists.entries()],
    });
  }

  return { hash, ids, approvalIds, registryRedis, transcriptRedis, approvalsRedis, run, storedText };
}

describe("Property 24: owner token never leaks", () => {
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

  it("**Validates: Requirements 6.4** no response, header or stored entry holds the token or its hash", async () => {
    const seen = new Set<number>();
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (sequence) => {
        const fx = await buildFixture();
        for (const action of sequence) {
          const { status, raw } = await serialise(await fx.run(action));
          seen.add(status);
          expect(leaks(raw, TOKEN, fx.hash), `leak in ${action.kind} -> ${status}`).toBe(false);
        }
        expect(leaks(fx.storedText(), TOKEN, fx.hash)).toBe(false);
      }),
      { numRuns: 100 },
    );
    // The generator must reach success, auth failure and storage failure, or the property proves nothing.
    expect(seen.has(200)).toBe(true);
    expect(seen.has(401)).toBe(true);
    expect(seen.has(503)).toBe(true);
    expect(seen.has(404)).toBe(true);
    expect(seen.has(400)).toBe(true);
  });

  it("the fixture holds the token hash in the service record, so the scan covers a real secret", async () => {
    const fx = await buildFixture();
    const record = fx.registryRedis.store.get(`service:${fx.ids.private}`);
    expect(record).toContain(fx.hash);
    expect(fx.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the detector flags the token or hash in a body, header or stored text", async () => {
    const fx = await buildFixture();
    expect(leaks("clean text", TOKEN, fx.hash)).toBe(false);
    expect(leaks(`prefix ${TOKEN} suffix`, TOKEN, fx.hash)).toBe(true);
    expect(leaks(`prefix ${fx.hash} suffix`, TOKEN, fx.hash)).toBe(true);
    expect(leaks(fx.hash.toUpperCase(), TOKEN, fx.hash)).toBe(true);

    const inBody = await serialise(Response.json({ echoed: TOKEN }));
    expect(leaks(inBody.raw, TOKEN, fx.hash)).toBe(true);
    const inHeader = await serialise(new Response("{}", { headers: { "x-debug": fx.hash } }));
    expect(leaks(inHeader.raw, TOKEN, fx.hash)).toBe(true);
    const ok = await serialise(await fx.run({ kind: "summary", svc: "private", auth: "right", fault: "none", variant: 0, aid: 0 }));
    expect(ok.status).toBe(200);
    expect(leaks(ok.raw, TOKEN, fx.hash)).toBe(false);

    fx.transcriptRedis.lists.set("transcripts:planted", [JSON.stringify({ summary: TOKEN })]);
    expect(leaks(fx.storedText(), TOKEN, fx.hash)).toBe(true);
  });
});

describe("services route source", () => {
  function routeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(full);
      return entry.name === "route.ts" ? [full] : [];
    });
  }

  it("no route file under app/api/services exports runtime", () => {
    const files = routeFiles(join("app", "api", "services"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/export\s+(?:const|let|var)\s+runtime\b/);
      expect(src, file).not.toMatch(/export\s*\{[^}]*\bruntime\b[^}]*\}/);
    }
  });
});
