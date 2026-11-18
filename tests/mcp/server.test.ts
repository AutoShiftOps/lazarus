import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import type { Deps } from "../../lib/mcp/pipeline";
import { createServerFor } from "../../lib/mcp/server";
import { buildTools } from "../../lib/mcp/tools";
import { createRegistry } from "../../lib/registry";
import { createApprovals } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { safePost } from "../../lib/soap/fetcher";
import { parseWsdl } from "../../lib/soap/parser";
import type { ServiceDefinition } from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const SERVICE_ID = "Abcd1234";
const NOW_MS = Date.parse("2026-01-01T12:00:00Z");
const INTERNAL_TEXT = "Something went wrong inside Lazarus. Nothing was sent.";

let service: ServiceDefinition;

beforeAll(async () => {
  const r = await parseWsdl(readFileSync("fixtures/gravewood.wsdl", "utf8"), {
    fetch: (url: string): never => {
      throw new Error(`network fetch attempted: ${url}`);
    },
  });
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  service = { ...r.definition, id: SERVICE_ID };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type PostCall = { url: string; body: string };

function makeDeps(overrides: Partial<Deps> = {}) {
  let clock = NOW_MS;
  let bank = seedState();
  let n = 0;
  const posts: PostCall[] = [];
  const transcriptRedis = createFakeTranscriptRedis();
  const post: typeof safePost = async (url, req) => {
    posts.push({ url, body: req.body });
    const r = handleSoap(bank, req.headers.SOAPAction ?? null, req.body, "2026-01-01T12:00:00Z");
    bank = r.state;
    return { ok: true, status: r.status, body: r.xml };
  };
  const approvals = createApprovals(createFakeApprovalsRedis(), { now: () => clock });
  const deps: Deps = {
    registry: createRegistry(createFakeRegistryRedis()),
    transcripts: createTranscripts(transcriptRedis),
    approvals,
    post,
    rateRedis: createFakeRateRedis(() => clock),
    now: () => clock++,
    sleep: async (ms) => {
      clock += ms;
    },
    newId: () => `id-${++n}`,
    ...overrides,
  };
  return { deps, posts, approvals, transcriptRedis };
}

async function connect(deps: Deps): Promise<Client> {
  const server = createServerFor(service, deps, { clientIp: "203.0.113.9" });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type TextContent = { type: string; text?: string };
function textOf(res: object): string {
  const content = (res as { content?: TextContent[] }).content;
  return content?.[0]?.text ?? "";
}

describe("tools/list", () => {
  it("lists every ToolDef unchanged, then check_approval", async () => {
    const client = await connect(makeDeps().deps);
    const { tools } = await client.listTools();
    const defs = buildTools(service);

    expect(tools.map((t) => t.name)).toEqual([...defs.map((d) => d.name), "check_approval"]);
    defs.forEach((d, i) => {
      expect(tools[i].description).toBe(d.description);
      expect(tools[i].inputSchema).toEqual(d.inputSchema);
      expect(tools[i].annotations).toEqual(d.annotations);
    });
  });

  it("describes check_approval with a required approvalId and the fixed annotations", async () => {
    const client = await connect(makeDeps().deps);
    const { tools } = await client.listTools();
    const check = tools.find((t) => t.name === "check_approval");
    expect(check).toBeDefined();
    expect(check?.inputSchema.type).toBe("object");
    expect(check?.inputSchema.required).toEqual(["approvalId"]);
    expect(Object.keys(check?.inputSchema.properties ?? {})).toEqual(["approvalId"]);
    expect(check?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });
});

describe("tools/call routing", () => {
  it("routes a known tool through the pipeline to the upstream", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);
    const res = await client.callTool({ name: "GetBalance", arguments: { accountId: "4471" } });
    expect(res.isError).toBeFalsy();
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].body).toContain("4471");
    expect(res.structuredContent).toBeDefined();
  });

  it("returns invalid arguments as a tool error, not a protocol error, without calling upstream", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);
    const res = await client.callTool({ name: "GetBalance", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Invalid arguments\./);
    expect(t.posts).toHaveLength(0);
  });

  it("answers an unknown tool with a tool error and never reaches post, rate limiter or transcripts", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);
    const res = await client.callTool({ name: "DropAllTables", arguments: { x: 1 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Unknown tool.");
    expect(t.posts).toHaveLength(0);
    expect(t.transcriptRedis.lists.size).toBe(0);
  });

  it("does not resolve inherited object keys as tools", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);
    for (const name of ["constructor", "__proto__", "toString"]) {
      const res = await client.callTool({ name });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Unknown tool.");
    }
    expect(t.posts).toHaveLength(0);
  });

  it("routes check_approval to the approval flow: pending, then executed once after approval", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);

    // Destructive call is held; the fake sleep moves the clock so the 20 s wait ends as "held".
    const held = await client.callTool({ name: "CloseAccount", arguments: { accountId: "4471" } });
    expect(held.isError).toBeFalsy();
    const structured = held.structuredContent as { status?: string; approvalId?: string } | undefined;
    expect(structured?.status).toBe("held");
    const approvalId = structured?.approvalId ?? "";
    expect(approvalId).not.toBe("");
    expect(t.posts).toHaveLength(0);

    const pending = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect(pending.isError).toBeFalsy();
    expect((pending.structuredContent as { status?: string }).status).toBe("held");
    expect(t.posts).toHaveLength(0);

    expect(await t.approvals.resolveApproval(SERVICE_ID, approvalId, "approve")).toBe("ok");
    const done = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect(done.isError).toBeFalsy();
    expect(t.posts).toHaveLength(1);

    const again = await client.callTool({ name: "check_approval", arguments: { approvalId } });
    expect((again.structuredContent as { status?: string }).status).toBe("executed");
    expect(t.posts).toHaveLength(1);
  });

  it("rejects a bad approvalId as a tool error and sends nothing", async () => {
    const t = makeDeps();
    const client = await connect(t.deps);
    for (const args of [{}, { approvalId: 42 }, { approvalId: "../x" }]) {
      const res = await client.callTool({ name: "check_approval", arguments: args });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Invalid approvalId.");
    }
    expect(t.posts).toHaveLength(0);
  });
});

describe("thrown errors", () => {
  it("become a fixed tool error with no message or stack text", async () => {
    const secret = "boom at 10.1.2.3 secret-token-xyz";
    const t = makeDeps({
      now: () => {
        throw new Error(secret);
      },
    });
    const client = await connect(t.deps);

    for (const call of [
      { name: "GetBalance", arguments: { accountId: "4471" } },
      { name: "check_approval", arguments: { approvalId: "abc" } },
    ]) {
      const res = await client.callTool(call);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(INTERNAL_TEXT);
      expect(JSON.stringify(res)).not.toContain("secret-token-xyz");
    }
    expect(t.posts).toHaveLength(0);
  });
});
