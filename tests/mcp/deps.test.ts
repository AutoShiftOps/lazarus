import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals, type ApprovalsRedis } from "../../lib/safety/approvals";
import { createTranscripts, type TranscriptRedis } from "../../lib/safety/transcript";
import type { TranscriptEntry } from "../../lib/safety/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;

describe("lib/mcp/deps", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("importing reads no env: it loads with no Upstash variables set", async () => {
    const mod = await import("../../lib/mcp/deps");
    expect(typeof mod.defaultDeps).toBe("function");
  });

  it("defaultDeps reads env only when called, and fails closed without it", async () => {
    const { defaultDeps } = await import("../../lib/mcp/deps");
    expect(() => defaultDeps()).toThrow();
  });

  it("defaultDeps builds a full Deps when env is present (no network on construction)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example-redis.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const { defaultDeps } = await import("../../lib/mcp/deps");
    const deps = defaultDeps();
    expect(typeof deps.now()).toBe("number");
    expect(deps.newId()).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(typeof deps.post).toBe("function");
    expect(typeof deps.approvals.createApproval).toBe("function");
    expect(typeof deps.transcripts.appendTranscript).toBe("function");
    expect(typeof deps.registry.getRules).toBe("function");
    expect(typeof deps.rateRedis.incr).toBe("function");
    const start = Date.now();
    await deps.sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });
});

describe("Upstash-style pre-parsed reads", () => {
  it("approvals read back when hgetall returns the data field already parsed", async () => {
    const inner = createFakeApprovalsRedis();
    const parsing: ApprovalsRedis = {
      ...inner,
      hset: (k, f) => inner.hset(k, f),
      hgetall: async (key) => {
        const h = await inner.hgetall(key);
        if (h === null) return null;
        const data: unknown = h.data;
        return { ...h, data: typeof data === "string" ? (JSON.parse(data) as unknown) : data };
      },
    };
    const approvals = createApprovals(parsing);
    const created = await approvals.createApproval("svc1", {
      serviceId: "svc1",
      tool: "CloseAccount",
      args: { accountId: "4471" },
      risk: "destructive",
      reason: "Destructive operation",
    });

    const raw = await parsing.hgetall(`approval:svc1:${created.id}`);
    expect(typeof raw?.data).toBe("object");

    const read = await approvals.getApproval("svc1", created.id);
    expect(read).toMatchObject({ id: created.id, tool: "CloseAccount", args: { accountId: "4471" }, status: "pending" });
    expect((await approvals.listApprovals("svc1")).map((a) => a.id)).toEqual([created.id]);
  });

  it("transcripts read back when lrange returns already-parsed objects", async () => {
    const inner = createFakeTranscriptRedis();
    const parsing: TranscriptRedis = {
      ...inner,
      lpush: (k, ...e) => inner.lpush(k, ...e),
      lrange: async (key, start, stop) => (await inner.lrange(key, start, stop)).map((s) => JSON.parse(String(s)) as unknown),
    };
    const transcripts = createTranscripts(parsing);
    const entry: TranscriptEntry = {
      id: "t1",
      ts: "2026-01-01T12:00:00.000Z",
      tool: "GetBalance",
      args: { accountId: "4471" },
      risk: "read",
      decision: "allow",
      outcome: "ok",
      durationMs: 3,
      summary: "GetBalance: ok",
    };
    await transcripts.appendTranscript("svc1", entry);

    const raw = await parsing.lrange("transcripts:svc1", 0, -1);
    expect(typeof raw[0]).toBe("object");

    const list = await transcripts.listTranscripts("svc1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "t1", tool: "GetBalance", outcome: "ok" });
  });
});
