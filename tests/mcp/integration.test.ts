import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import { handleMcpRequest, MAX_BODY_BYTES, type McpHttpDeps } from "../../lib/mcp/http";
import { buildTools } from "../../lib/mcp/tools";
import { createRegistry, type Registry } from "../../lib/registry";
import { createApprovals } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { safePost } from "../../lib/soap/fetcher";
import { parseWsdl } from "../../lib/soap/parser";
import type { ServiceDefinition } from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const NOW_MS = Date.parse("2026-01-01T12:00:00Z");
const OWNER_HASH = "c0ffee1234567890".repeat(4);
const REDIS_SECRET = "redis-down-secret-host.internal:6379";

let definition: ServiceDefinition;

beforeAll(async () => {
  const r = await parseWsdl(readFileSync("fixtures/gravewood.wsdl", "utf8"), {
    fetch: (url: string): never => {
      throw new Error(`network fetch attempted: ${url}`);
    },
  });
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  definition = { ...r.definition, wsdlUrl: "https://gravewood.example/bank?wsdl", ownerTokenHash: OWNER_HASH };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Harness = {
  id: string;
  deps: McpHttpDeps;
  registry: Registry;
  registryRedis: ReturnType<typeof createFakeRegistryRedis>;
  transcriptRedis: ReturnType<typeof createFakeTranscriptRedis>;
  approvals: ReturnType<typeof createApprovals>;
  posts: string[];
  sleeps: number[];
  registryCalls: string[];
  responses: string[];
  client: () => Promise<Client>;
  request: (id: string, init?: RequestInit) => Promise<Response>;
};

async function makeHarness(opts: { onSleep?: (h: Harness) => Promise<void> } = {}): Promise<Harness> {
  let clock = NOW_MS;
  let bank = seedState();
  let n = 0;
  const posts: string[] = [];
  const sleeps: number[] = [];
  const registryCalls: string[] = [];
  const responses: string[] = [];
  const registryRedis = createFakeRegistryRedis();
  const transcriptRedis = createFakeTranscriptRedis();
  const registry = createRegistry(registryRedis);
  const approvals = createApprovals(createFakeApprovalsRedis(), { now: () => clock });

  const up = await registry.upsertService(definition);
  if (!up.ok) throw new Error("seed failed");
  const id = up.id;

  const post: typeof safePost = async (_url, req) => {
    posts.push(req.body);
    const r = handleSoap(bank, req.headers.SOAPAction ?? null, req.body, "2026-01-01T12:00:00Z");
    bank = r.state;
    return { ok: true, status: r.status, body: r.xml };
  };

  const deps: McpHttpDeps = {
    registry: {
      getService: (i) => {
        registryCalls.push(i);
        return registry.getService(i);
      },
      getRules: (i) => registry.getRules(i),
      getSettings: (i) => registry.getSettings(i),
    },
    transcripts: createTranscripts(transcriptRedis),
    approvals,
    post,
    rateRedis: createFakeRateRedis(() => clock),
    now: () => clock++,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (opts.onSleep) await opts.onSleep(h);
    },
    newId: () => `id-${++n}`,
  };

  const request = async (target: string, init?: RequestInit): Promise<Response> => {
    const res = await handleMcpRequest(new Request(`http://localhost/api/mcp/${target}`, init), target, deps);
    responses.push(await res.clone().text());
    return res;
  };

  const h: Harness = {
    id,
    deps,
    registry,
    registryRedis,
    transcriptRedis,
    approvals,
    posts,
    sleeps,
    registryCalls,
    responses,
    request,
    client: async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://localhost/api/mcp/${id}`), {
        fetch: async (url, init) => {
          const res = await handleMcpRequest(new Request(url, init), id, deps);
          responses.push(await res.clone().text());
          return res;
        },
      });
      const client = new Client({ name: "integration", version: "0.0.0" });
      await client.connect(transport);
      return client;
    },
  };
  return h;
}

type Structured = Record<string, unknown> | undefined;
function structured(res: object): Structured {
  return (res as { structuredContent?: Structured }).structuredContent;
}
function textOf(res: object): string {
  const content = (res as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}
function closeCalls(h: Harness): number {
  return h.posts.filter((b) => b.includes("CloseAccount")).length;
}
function allTranscripts(h: Harness): string {
  return [...h.transcriptRedis.lists.values()].flat().join("\n");
}

describe("MCP gateway end to end (SDK client -> handler -> Gravewood)", () => {
  it("lists six operations plus check_approval with the Risk line first", async () => {
    const h = await makeHarness();
    const client = await h.client();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["CloseAccount", "GetBalance", "GetStatement", "ListAccounts", "TransferFunds", "UpdateAddress", "check_approval"],
    );
    const ops = tools.filter((t) => t.name !== "check_approval");
    expect(ops).toHaveLength(6);
    for (const t of ops) expect(t.description).toMatch(/^Risk: (read|write|destructive) — /);
    const byName = new Map(buildTools(definition).map((d) => [d.name, d]));
    expect(byName.get("CloseAccount")?.description.startsWith("Risk: destructive")).toBe(true);
    expect(tools.find((t) => t.name === "CloseAccount")?.description?.startsWith("Risk: destructive")).toBe(true);
    expect(tools.find((t) => t.name === "GetBalance")?.description?.startsWith("Risk: read")).toBe(true);
  });

  it("runs GetBalance end to end", async () => {
    const h = await makeHarness();
    const client = await h.client();
    const res = await client.callTool({ name: "GetBalance", arguments: { accountId: "4471" } });
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual({ accountId: "4471", balance: 12450, asOf: "2026-01-01T12:00:00Z" });
    expect(h.posts).toHaveLength(1);
  });

  it("runs the write TransferFunds end to end", async () => {
    const h = await makeHarness();
    const client = await h.client();
    const res = await client.callTool({
      name: "TransferFunds",
      arguments: { fromAccount: "4471", toAccount: "5530", amount: 25.5 },
    });
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ fromBalance: 12424.5, toBalance: 48025.5 });
    expect(h.posts).toHaveLength(1);
  });

  it("holds CloseAccount after the 20 s wait, then executes it once after approval", async () => {
    const h = await makeHarness();
    const client = await h.client();

    const held = await client.callTool({ name: "CloseAccount", arguments: { accountId: "4471" } });
    expect(held.isError).toBeFalsy();
    const heldData = structured(held);
    expect(heldData?.status).toBe("held");
    const approvalId = String(heldData?.approvalId ?? "");
    expect(approvalId).not.toBe("");
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20_000);
    expect(closeCalls(h)).toBe(0);

    expect(await h.approvals.resolveApproval(h.id, approvalId, "approve")).toBe("ok");

    const done = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect(done.isError).toBeFalsy();
    expect(structured(done)).toEqual({ closed: true, closedAt: "2026-01-01T12:00:00Z" });
    expect(closeCalls(h)).toBe(1);
    expect(h.posts).toHaveLength(1);

    const again = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect(again.isError).toBeFalsy();
    expect(structured(again)?.status).toBe("executed");
    expect(closeCalls(h)).toBe(1);
    expect(h.posts).toHaveLength(1);
  });

  it("returns a tool error and sends nothing when a human denies a held call", async () => {
    const h = await makeHarness({
      onSleep: async (self) => {
        const pending = (await self.approvals.listApprovals(self.id)).filter((a) => a.status === "pending");
        for (const a of pending) await self.approvals.resolveApproval(self.id, a.id, "deny", "not today");
      },
    });
    const client = await h.client();
    const res = await client.callTool({ name: "CloseAccount", arguments: { accountId: "4471" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^A human refused this call\./);
    expect(textOf(res)).toContain("not today");
    expect(h.posts).toHaveLength(0);

    const approvalId = (await h.approvals.listApprovals(h.id))[0]?.id ?? "";
    expect(approvalId).not.toBe("");
    const check = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect(check.isError).toBe(true);
    expect(textOf(check)).toMatch(/^A human refused this call\./);
    expect(h.posts).toHaveLength(0);
  });

  it("simulates write calls in ghost mode without calling the upstream", async () => {
    const h = await makeHarness();
    expect(await h.registry.putSettings(h.id, { ghost: true })).toEqual({ ok: true });
    const client = await h.client();

    const res = await client.callTool({
      name: "TransferFunds",
      arguments: { fromAccount: "4471", toAccount: "5530", amount: 25.5 },
    });
    expect(res.isError).toBeFalsy();
    expect(structured(res)?.ghost).toBe(true);
    expect(textOf(res)).toContain("[GHOST");
    expect(h.posts).toHaveLength(0);
  });

  it("never exposes ownerTokenHash in any response or transcript", async () => {
    const h = await makeHarness();
    // The hash really is stored, so the scan below is not vacuous.
    expect([...h.registryRedis.store.values()].join("")).toContain(OWNER_HASH);

    const client = await h.client();
    await client.listTools();
    await client.callTool({ name: "GetBalance", arguments: { accountId: "4471" } });
    await client.callTool({ name: "GetBalance", arguments: { accountId: "9999" } });
    await client.callTool({ name: "GetBalance", arguments: {} });
    await client.callTool({ name: "check_approval", arguments: { approvalId: "nope" } });
    await h.request("zzzzzzzz", { method: "POST", body: "{}" });
    await h.request(h.id, { method: "GET" });

    expect(h.responses.length).toBeGreaterThan(5);
    expect(h.responses.join("\n")).not.toContain(OWNER_HASH);
    expect(h.responses.join("\n")).not.toContain("ownerTokenHash");
    const transcripts = allTranscripts(h);
    expect(transcripts).not.toBe("");
    expect(transcripts).not.toContain(OWNER_HASH);
    expect(transcripts).not.toContain("ownerTokenHash");
  });
});

describe("handler responses outside the SDK client", () => {
  const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const postInit = (body: string): RequestInit => ({
    method: "POST",
    body,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  });

  it("answers an unknown but well-formed service id with 404", async () => {
    const h = await makeHarness();
    const res = await h.request("Unknown123", postInit(LIST));
    expect(res.status).toBe(404);
    expect(h.registryCalls).toEqual(["Unknown123"]);
  });

  it("answers a non-matching id with 404 and makes no registry call", async () => {
    const h = await makeHarness();
    const res = await h.request("bad!", postInit(LIST));
    expect(res.status).toBe(404);
    expect(h.registryCalls).toEqual([]);
  });

  it("answers GET with 405", async () => {
    const h = await makeHarness();
    const res = await h.request(h.id, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("answers OPTIONS with CORS headers", async () => {
    const h = await makeHarness();
    const res = await h.request(h.id, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("answers a body over 256 KB with 413", async () => {
    const h = await makeHarness();
    const res = await h.request(h.id, postInit(JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) })));
    expect(res.status).toBe(413);
    expect(h.registryCalls).toEqual([]);
  });

  it("answers a registry failure with 503 and no internal text", async () => {
    const h = await makeHarness();
    h.registryRedis.failWith = new Error(REDIS_SECRET);
    const res = await h.request(h.id, postInit(LIST));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(REDIS_SECRET);
    expect(text).not.toContain("redis");
    expect((JSON.parse(text) as { error: { message: string } }).error.message).toBe(
      "The registry is temporarily unavailable.",
    );
  });
});
