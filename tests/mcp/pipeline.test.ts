import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { seedState } from "../../lib/gravewood/seed";
import { ghostResponse } from "../../lib/safety/ghost";
import { createPipeline, truncateUtf8, type McpToolResult } from "../../lib/mcp/pipeline";
import { buildTools, type ToolDef } from "../../lib/mcp/tools";
import { createRegistry } from "../../lib/registry";
import { createApprovals, type ApprovalsRedis } from "../../lib/safety/approvals";
import { createTranscripts } from "../../lib/safety/transcript";
import type { Rule, TranscriptEntry } from "../../lib/safety/types";
import type { safePost } from "../../lib/soap/fetcher";
import { parseWsdl } from "../../lib/soap/parser";
import type { ServiceDefinition } from "../../lib/soap/types";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";
import { createFakeRateRedis } from "../helpers/fake-rate-redis";
import { createFakeRegistryRedis } from "../helpers/fake-registry-redis";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const NOW_MS = Date.parse("2026-01-01T12:00:00Z");
const SERVICE_ID = "Abcd1234";

let service: ServiceDefinition;
let tools: Map<string, ToolDef>;

beforeAll(async () => {
  const xml = readFileSync("fixtures/gravewood.wsdl", "utf8");
  const r = await parseWsdl(xml, {
    fetch: (url: string): never => {
      throw new Error(`network fetch attempted: ${url}`);
    },
  });
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  service = { ...r.definition, id: SERVICE_ID };
  tools = new Map(buildTools(service).map((t) => [t.name, t]));
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function tool(name: string): ToolDef {
  const t = tools.get(name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

type PostFn = typeof safePost;
type PostCall = { url: string; body: string; headers: Record<string, string>; timeoutMs?: number };

type SetupOpts = {
  /** Scripted "human": runs after every fake sleep, with the 1-based sleep count. */
  human?: (sleepCount: number) => Promise<void>;
};

function setup(customPost?: PostFn, opts: SetupOpts = {}) {
  const registryRedis = createFakeRegistryRedis();
  const transcriptRedis = createFakeTranscriptRedis();
  let clock = NOW_MS;
  const calls: PostCall[] = [];
  let bank = seedState();
  let n = 0;

  const bankPost: PostFn = async (url, req) => {
    calls.push({ url, body: req.body, headers: req.headers, timeoutMs: req.timeoutMs });
    const r = handleSoap(bank, req.headers.SOAPAction ?? null, req.body, "2026-01-01T12:00:00Z");
    bank = r.state;
    return { ok: true, status: r.status, body: r.xml };
  };
  const recordingCustom: PostFn | undefined = customPost
    ? async (url, req) => {
        calls.push({ url, body: req.body, headers: req.headers, timeoutMs: req.timeoutMs });
        return customPost(url, req);
      }
    : undefined;

  const rateRedis = createFakeRateRedis(() => clock);
  const approvalsFake = createFakeApprovalsRedis();
  const flags = { failCreate: false, failPoll: false };
  const approvalsRedis: ApprovalsRedis = {
    ...approvalsFake,
    hset: async (key, fields) => {
      if (flags.failCreate) throw new Error("approval store down at 10.1.2.3");
      return approvalsFake.hset(key, fields);
    },
    hgetall: async (key) => {
      if (flags.failPoll) throw new Error("approval store down at 10.1.2.3");
      return approvalsFake.hgetall(key);
    },
  };
  const approvals = createApprovals(approvalsRedis, { now: () => clock });
  let sleeps = 0;
  const sleepLog: number[] = [];
  const innerRegistry = createRegistry(registryRedis);
  const registryReads = { count: 0 };
  const pipeline = createPipeline({
    registry: {
      getRules: (id) => {
        registryReads.count++;
        return innerRegistry.getRules(id);
      },
      getSettings: (id) => {
        registryReads.count++;
        return innerRegistry.getSettings(id);
      },
    },
    transcripts: createTranscripts(transcriptRedis),
    approvals,
    post: recordingCustom ?? bankPost,
    rateRedis,
    now: () => clock++,
    sleep: async (ms) => {
      sleepLog.push(ms);
      clock += ms;
      sleeps++;
      if (opts.human) await opts.human(sleeps);
    },
    newId: () => `id-${++n}`,
  });

  const registry = createRegistry(registryRedis);
  return {
    pipeline,
    calls,
    registry,
    registryRedis,
    transcriptRedis,
    bank: () => bank,
    rateRedis,
    approvals,
    flags,
    sleepLog,
    now: (): number => clock,
    registryReads,
    advance: (ms: number): void => {
      clock += ms;
    },
    runFrom: (ip: string, name: string, args: unknown): Promise<McpToolResult> =>
      pipeline.runCall({ service, tool: tool(name), args, clientIp: ip }),
    run: (name: string, args: unknown): Promise<McpToolResult> =>
      pipeline.runCall({ service, tool: tool(name), args, clientIp: "203.0.113.9" }),
    rawTranscripts: (): string[] => transcriptRedis.lists.get(`transcripts:${SERVICE_ID}`) ?? [],
    entries: (): TranscriptEntry[] =>
      (transcriptRedis.lists.get(`transcripts:${SERVICE_ID}`) ?? []).map(
        (s) => JSON.parse(s) as TranscriptEntry,
      ),
  };
}

function textOf(r: McpToolResult): string {
  return r.content[0].text;
}

function faultEnvelope(faultString: string): string {
  return (
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>` +
    `<faultcode>soap:Server</faultcode><faultstring>${faultString}</faultstring>` +
    `</soap:Fault></soap:Body></soap:Envelope>`
  );
}

describe("pipeline: allow path", () => {
  it("runs a read end to end with real SOAP and records the transcript", async () => {
    const t = setup();
    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ accountId: "4471", balance: 12450 });
    expect(JSON.parse(textOf(res))).toEqual(res.structuredContent);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(tool("GetBalance").op.endpointAddress);
    expect(t.calls[0].timeoutMs).toBe(25_000);
    expect(t.calls[0].body).toContain("GetBalance");

    const [entry] = t.entries();
    expect(t.entries()).toHaveLength(1);
    expect(entry).toMatchObject({
      tool: "GetBalance",
      risk: "read",
      decision: "allow",
      outcome: "ok",
      args: { accountId: "4471" },
    });
    expect(entry.soapRequest).toContain("GetBalance");
    expect(entry.soapResponse).toContain("12450");
  });

  it("runs a write end to end and changes the fake bank", async () => {
    const t = setup();
    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 100 });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ fromBalance: 12350, toBalance: 48100 });
    const balance = (id: string) => t.bank().accounts.find((a) => a.id === id)?.balanceCents;
    expect(balance("4471")).toBe(1235000);
    expect(balance("5530")).toBe(4810000);
    expect(t.entries()[0]).toMatchObject({ decision: "allow", outcome: "ok", risk: tool("TransferFunds").op.risk });
  });
});

describe("pipeline: faults", () => {
  it("passes a service fault through as a tool error", async () => {
    const t = setup();
    const res = await t.run("GetBalance", { accountId: "9999" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Account 9999 not found");
    expect(res.structuredContent).toBeUndefined();
    const [entry] = t.entries();
    expect(entry.outcome).toBe("fault");
    expect(entry.summary).not.toContain("not found");
    expect(entry.summary).not.toContain("Account");
  });

  it("strips control characters and caps a long fault string at 300", async () => {
    const long = `Boom\t\n\u0085\u009b\u200b ${"x".repeat(600)}`;
    const t = setup(async () => ({ ok: true, status: 500, body: faultEnvelope(long) }));
    const res = await t.run("GetBalance", { accountId: "4471" });

    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(300);
    expect(Array.from(text).length).toBe(300);
    expect(text.startsWith("Boom x")).toBe(true);
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(text).not.toContain("<");
    expect(t.entries()[0].outcome).toBe("fault");
  });
});

describe("pipeline: validation", () => {
  it("names the field but never echoes the value, and does not contact the upstream", async () => {
    const t = setup();
    const res = await t.run("GetBalance", { accountId: { nested: "SECRET-VALUE-123" } });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("accountId");
    expect(textOf(res)).not.toContain("SECRET-VALUE-123");
    expect(t.calls).toHaveLength(0);

    const [entry] = t.entries();
    expect(entry).toMatchObject({ outcome: "error", args: null });
    expect(entry.summary).toContain("1 invalid argument");
    expect(t.rawTranscripts().join("")).not.toContain("SECRET-VALUE-123");
  });

  it("rejects a missing required field without contacting the upstream", async () => {
    const t = setup();
    const res = await t.run("GetBalance", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("accountId");
    expect(t.calls).toHaveLength(0);
  });
});

describe("pipeline: policy and failure modes", () => {
  it("fails closed when the registry is unavailable", async () => {
    const t = setup();
    t.registryRedis.failWith = new Error("redis exploded at 10.1.2.3");
    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("10.1.2.3");
    expect(t.calls).toHaveLength(0);
    expect(t.entries()[0]).toMatchObject({ outcome: "error", args: null });
  });

  it("returns the same result when the transcript store is down", async () => {
    const working = setup();
    const okRes = await working.run("GetBalance", { accountId: "4471" });
    const okFault = await working.run("GetBalance", { accountId: "9999" });

    const broken = setup();
    broken.transcriptRedis.failWith = new Error("transcript store down");
    const res = await broken.run("GetBalance", { accountId: "4471" });
    const fault = await broken.run("GetBalance", { accountId: "9999" });

    expect(res).toEqual(okRes);
    expect(fault).toEqual(okFault);
    expect(res.isError).toBeUndefined();
    expect(broken.transcriptRedis.lists.size).toBe(0);
    expect(working.entries()).toHaveLength(2);
  });

  it("never puts argument values or upstream text into summaries", async () => {
    const t = setup();
    const rules: Rule[] = [
      {
        id: "no-secret-address",
        operation: "UpdateAddress",
        when: { field: "address", op: "contains", value: "SECRET" },
        effect: "block",
        reason: "blocked by test",
      },
      {
        id: "big-transfer",
        operation: "TransferFunds",
        when: { field: "amount", op: "gt", value: 50 },
        effect: "hold",
        reason: "held by test",
      },
    ];
    expect((await t.registry.putRules(SERVICE_ID, rules)).ok).toBe(true);

    const blocked = await t.run("UpdateAddress", { accountId: "4471", address: "SECRET-ADDR-777" });
    const held = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 987654 });
    const allowed = await t.run("UpdateAddress", { accountId: "4471", address: "1 Hollow Creek Rd" });
    await t.run("GetBalance", { accountId: "9999" });

    expect(blocked.isError).toBe(true);
    expect(held.isError).toBeUndefined();
    expect(held.structuredContent).toMatchObject({ status: "held" });
    expect(allowed.isError).toBeUndefined();

    const entries = t.entries();
    expect(entries.map((e) => e.outcome).sort()).toEqual(["blocked", "fault", "held", "ok"]);
    expect(entries.find((e) => e.outcome === "blocked")?.ruleId).toBe("no-secret-address");
    expect(entries.find((e) => e.outcome === "held")?.ruleId).toBe("big-transfer");
    for (const e of entries) {
      expect(e.summary).not.toContain("SECRET-ADDR-777");
      expect(e.summary).not.toContain("987654");
      expect(e.summary).not.toContain("1 Hollow Creek Rd");
      expect(e.summary).not.toContain("9999");
      expect(e.summary).not.toContain("not found");
    }
    // The blocked and held calls never reached the upstream: only the allowed write and the read did.
    expect(t.calls).toHaveLength(2);
  });
});

describe("pipeline: upstream failures", () => {
  const NO_ANSWER = "The spirit did not answer.";

  it("maps a failed post to the fixed message without leaking the cause", async () => {
    const t = setup(async () => ({
      ok: false,
      error: { code: "TIMEOUT", message: "internal detail xyz" },
    }));
    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(NO_ANSWER);
    expect(t.entries()[0].outcome).toBe("error");
    expect(t.rawTranscripts().join("")).not.toContain("xyz");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("xyz");
  });

  it("maps a throwing post to the fixed message", async () => {
    const t = setup(async () => {
      throw new Error("kaboom internal detail xyz");
    });
    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(NO_ANSWER);
    expect(t.entries()[0].outcome).toBe("error");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("xyz");
  });

  it("maps a non-fault HTTP 502 with a non-XML body to the fixed message", async () => {
    const t = setup(async () => ({ ok: true, status: 502, body: "<html>Bad gateway from 10.0.0.7</html>" }));
    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(NO_ANSWER);
    expect(textOf(res)).not.toContain("10.0.0.7");
    expect(t.entries()[0].summary).not.toContain("Bad gateway");
  });
});

describe("pipeline: result size cap", () => {
  it("caps the result text at 64 KB of UTF-8 without splitting a character", async () => {
    const huge = "é".repeat(100_000);
    const t = setup(async (_url, req) => {
      const bank = seedState();
      const r = handleSoap(bank, req.headers.SOAPAction ?? null, req.body, "2026-01-01T12:00:00Z");
      return { ok: true, status: 200, body: r.xml.replace(">4471<", `>${huge}<`) };
    });
    const res = await t.run("GetBalance", { accountId: "4471" });

    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(65_536);
    expect(text).toContain("[result truncated]");
    expect(text).not.toContain("\uFFFD");
    expect(text.startsWith('{"accountId":"é')).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  it("truncateUtf8 never cuts inside a multi-byte character", () => {
    expect(truncateUtf8("aé", 2)).toBe("a");
    expect(truncateUtf8("aé", 3)).toBe("aé");
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(truncateUtf8("a😀", 4)).toBe("a");
  });
});

const GHOST_PREFIX = "[GHOST — nothing was sent to the real service]";
const BIG_BLOCK: Rule = {
  id: "no-big",
  operation: "TransferFunds",
  when: { field: "amount", op: "gt", value: 1000 },
  effect: "block",
  reason: "Transfers over 1000 are blocked",
};

async function enableGhost(t: ReturnType<typeof setup>): Promise<void> {
  expect((await t.registry.putSettings(SERVICE_ID, { ghost: true })).ok).toBe(true);
}

describe("pipeline: block path", () => {
  it("returns the rule reason as a tool error without calling the upstream", async () => {
    const t = setup();
    expect((await t.registry.putRules(SERVICE_ID, [BIG_BLOCK])).ok).toBe(true);
    const before = JSON.stringify(t.bank());

    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 5000 });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Transfers over 1000 are blocked");
    expect(t.calls).toHaveLength(0);
    expect(JSON.stringify(t.bank())).toBe(before);
    expect(t.entries()[0]).toMatchObject({ decision: "block", outcome: "blocked", ruleId: "no-big" });
  });

  it("lets a call below the threshold through", async () => {
    const t = setup();
    expect((await t.registry.putRules(SERVICE_ID, [BIG_BLOCK])).ok).toBe(true);
    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 10 });
    expect(res.isError).toBeUndefined();
    expect(t.calls).toHaveLength(1);
  });

  it("beats ghost mode", async () => {
    const t = setup();
    expect((await t.registry.putRules(SERVICE_ID, [BIG_BLOCK])).ok).toBe(true);
    await enableGhost(t);

    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 5000 });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Transfers over 1000 are blocked");
    expect(res.structuredContent).toBeUndefined();
    expect(t.calls).toHaveLength(0);
    expect(t.entries()[0]).toMatchObject({ decision: "block", outcome: "blocked", ruleId: "no-big" });
  });

  it("falls back to a fixed message when the reason is empty after sanitising", async () => {
    const t = setup();
    const rule: Rule = { ...BIG_BLOCK, reason: "\u200b\u0007 " };
    expect((await t.registry.putRules(SERVICE_ID, [rule])).ok).toBe(true);
    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 5000 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("This call is blocked by policy.");
  });

  it("keeps reason text and argument values out of the transcript summary", async () => {
    const t = setup();
    const rule: Rule = {
      id: "no-secret-address",
      operation: "UpdateAddress",
      when: { field: "address", op: "contains", value: "SECRET" },
      effect: "block",
      reason: "Address SECRET-ADDR-777 is not allowed",
    };
    expect((await t.registry.putRules(SERVICE_ID, [rule])).ok).toBe(true);

    const res = await t.run("UpdateAddress", { accountId: "4471", address: "SECRET-ADDR-777" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("SECRET-ADDR-777"); // the agent sees the rule author's reason
    const [entry] = t.entries();
    expect(entry.outcome).toBe("blocked");
    expect(entry.summary).toContain("UpdateAddress");
    expect(entry.summary).not.toContain("SECRET");
    expect(entry.summary).not.toContain("not allowed");
    expect(entry.summary).not.toContain("4471");
  });
});

describe("pipeline: ghost path", () => {
  it("simulates a write without contacting the upstream", async () => {
    const t = setup();
    await enableGhost(t);
    const before = JSON.stringify(t.bank());

    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 100 });

    expect(res.isError).toBeUndefined();
    expect(textOf(res).startsWith(GHOST_PREFIX)).toBe(true);
    expect(res.structuredContent).toMatchObject({ ghost: true });
    expect(t.calls).toHaveLength(0);
    expect(JSON.stringify(t.bank())).toBe(before);
    expect(t.entries()[0]).toMatchObject({ decision: "ghost", outcome: "ghost", risk: tool("TransferFunds").op.risk });
    expect(t.entries()[0].soapRequest).toBeUndefined();
  });

  it("simulates a destructive call without contacting the upstream", async () => {
    const t = setup();
    await enableGhost(t);

    const res = await t.run("CloseAccount", { accountId: "4471" });

    expect(res.isError).toBeUndefined();
    expect(textOf(res).startsWith(GHOST_PREFIX)).toBe(true);
    expect(res.structuredContent?.ghost).toBe(true);
    expect(t.calls).toHaveLength(0);
    expect(t.bank().accounts.find((a) => a.id === "4471")?.status).toBe("OPEN");
    expect(t.entries()[0]).toMatchObject({ decision: "ghost", outcome: "ghost" });
  });

  it("returns exactly ghostResponse(op) as text and structured content", async () => {
    const t = setup();
    await enableGhost(t);

    for (const name of ["TransferFunds", "CloseAccount"]) {
      const sample = ghostResponse(tool(name).op);
      const res = await t.run(name, name === "CloseAccount"
        ? { accountId: "4471" }
        : { fromAccount: "4471", toAccount: "5530", amount: 100 });
      expect(textOf(res)).toBe(`${GHOST_PREFIX}\n${JSON.stringify(sample)}`);
      expect(res.structuredContent).toEqual({ ghost: true, result: sample });
    }
    expect(t.calls).toHaveLength(0);
  });

  it("lets a read through to the real service in ghost mode", async () => {
    const t = setup();
    await enableGhost(t);

    const res = await t.run("GetBalance", { accountId: "4471" });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ accountId: "4471", balance: 12450 });
    expect(res.structuredContent).not.toHaveProperty("ghost");
    expect(textOf(res).startsWith(GHOST_PREFIX)).toBe(false);
    expect(t.calls).toHaveLength(1);
    expect(t.entries()[0]).toMatchObject({ decision: "allow", outcome: "ok" });
  });
});

describe("pipeline: rate limiting", () => {
  const READ = { accountId: "4471" };

  it("allows 10 calls per IP, refuses the 11th, and still serves another IP", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect((await t.runFrom("198.51.100.1", "GetBalance", READ)).isError).toBeUndefined();
    }
    expect(t.calls).toHaveLength(10);

    const res = await t.runFrom("198.51.100.1", "GetBalance", READ);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Too many calls");
    expect(t.calls).toHaveLength(10);

    const other = await t.runFrom("198.51.100.2", "GetBalance", READ);
    expect(other.isError).toBeUndefined();
    expect(t.calls).toHaveLength(11);
  });

  it("allows 30 calls per service across IPs and refuses the 31st from a fresh IP", async () => {
    const t = setup();
    for (let i = 0; i < 30; i++) {
      const ip = `192.0.2.${Math.floor(i / 10) + 1}`;
      expect((await t.runFrom(ip, "GetBalance", READ)).isError).toBeUndefined();
    }
    expect(t.calls).toHaveLength(30);

    const res = await t.runFrom("192.0.2.200", "GetBalance", READ);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Too many calls");
    expect(t.calls).toHaveLength(30);
  });

  it("lets calls through again after the 60 second window", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await t.runFrom("198.51.100.1", "GetBalance", READ);
    expect(textOf(await t.runFrom("198.51.100.1", "GetBalance", READ))).toBe("Too many calls");

    t.advance(60_000);
    const res = await t.runFrom("198.51.100.1", "GetBalance", READ);
    expect(res.isError).toBeUndefined();
    expect(t.calls).toHaveLength(11);
  });

  it("records a blocked transcript entry and does nothing else", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await t.runFrom("198.51.100.1", "GetBalance", READ);
    const readsBefore = t.registryReads.count;

    await t.runFrom("198.51.100.1", "GetBalance", { accountId: "SECRET-VALUE-123" });

    expect(t.registryReads.count).toBe(readsBefore);
    const entries = t.entries();
    expect(entries).toHaveLength(11);
    const last = entries[0]; // newest first
    expect(entries.filter((e) => e.outcome === "blocked")).toHaveLength(1);
    expect(last.outcome).toBe("blocked");
    expect(last.summary).toBe("GetBalance: rate limited, nothing was sent");
    expect(t.rawTranscripts().join("")).not.toContain("SECRET-VALUE-123");
  });

  it("fails closed when the limiter store is down", async () => {
    const t = setup();
    t.rateRedis.failWith = new Error("redis exploded at 10.1.2.3");

    const res = await t.run("GetBalance", READ);

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("10.1.2.3");
    expect(textOf(res)).not.toContain("exploded");
    expect(t.calls).toHaveLength(0);
    expect(t.registryReads.count).toBe(0);
    const [entry] = t.entries();
    expect(t.entries()).toHaveLength(1);
    expect(entry.outcome).toBe("error");
    expect(entry.summary).toBe("GetBalance: rate limiter unavailable, nothing was sent");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("10.1.2.3");
  });

  it("keeps a hostile client IP from injecting key separators or growing the key", async () => {
    const t = setup();
    const evil = `1.2.3.4:x\r\n*${"z".repeat(5000)}`;
    for (let i = 0; i < 10; i++) expect((await t.runFrom(evil, "GetBalance", READ)).isError).toBeUndefined();
    expect(textOf(await t.runFrom(evil, "GetBalance", READ))).toBe("Too many calls");
  });
});

type Harness = ReturnType<typeof setup>;
const CLOSE = { accountId: "4471" };
const HELD_AFTER_MS = 20_000;

async function onlyApproval(t: Harness) {
  const list = await t.approvals.listApprovals(SERVICE_ID);
  expect(list).toHaveLength(1);
  return list[0];
}

async function decideOnly(t: Harness, d: "approve" | "deny", note?: string): Promise<void> {
  const a = await onlyApproval(t);
  expect(await t.approvals.resolveApproval(SERVICE_ID, a.id, d, note)).toBe("ok");
}

describe("pipeline: hold path", () => {
  it("creates a pending approval with the parsed args, then reports held after 20 s", async () => {
    const t: Harness = setup();
    const start = t.now();
    const res = await t.run("CloseAccount", CLOSE);

    const a = await onlyApproval(t);
    expect(a).toMatchObject({
      tool: "CloseAccount",
      args: CLOSE,
      risk: tool("CloseAccount").op.risk,
      status: "pending",
      serviceId: SERVICE_ID,
    });
    expect(a.reason.length).toBeGreaterThan(0);
    expect(a.reason.length).toBeLessThanOrEqual(200);

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ status: "held", approvalId: a.id, expiresAt: a.expiresAt });
    expect(textOf(res)).toContain("check_approval");
    expect(textOf(res)).toContain(a.id);
    // Polled every 500 ms on the fake clock, and the wait covered 20 s of fake time.
    expect(t.sleepLog.length).toBeGreaterThanOrEqual(39);
    expect(new Set(t.sleepLog)).toEqual(new Set([500]));
    expect(t.now() - start).toBeGreaterThanOrEqual(HELD_AFTER_MS);
    expect(t.now() - start).toBeLessThan(HELD_AFTER_MS + 1000);
    expect(t.calls).toHaveLength(0);
    expect(t.bank().accounts.find((x) => x.id === "4471")?.status).toBe("OPEN");

    const [entry] = t.entries();
    expect(t.entries()).toHaveLength(1);
    expect(entry).toMatchObject({ decision: "hold", outcome: "held", approvalId: a.id });
  });

  it("runs the call when a human approves during the wait and returns the real result", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n === 3) await decideOnly(t, "approve");
      },
    });
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ closed: true });
    expect(t.sleepLog).toHaveLength(3);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body).toContain("4471");
    expect(t.bank().accounts.find((x) => x.id === "4471")?.status).toBe("CLOSED");

    const a = await onlyApproval(t);
    expect(a.status).toBe("executed");
    const [entry] = t.entries();
    expect(entry).toMatchObject({ outcome: "ok", approvalId: a.id });
    expect(entry.soapRequest).toContain("CloseAccount");
  });

  it("returns a refusal with the note when a human denies, and touches nothing", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n === 2) await decideOnly(t, "deny", "Not today\u200b");
      },
    });
    const before = JSON.stringify(t.bank());
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("A human refused this call. Not today");
    expect(t.calls).toHaveLength(0);
    expect(JSON.stringify(t.bank())).toBe(before);
    const a = await onlyApproval(t);
    expect(t.entries()[0]).toMatchObject({ decision: "hold", outcome: "blocked", approvalId: a.id });
  });

  it("returns the plain refusal when there is no note", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n === 1) await decideOnly(t, "deny");
      },
    });
    const res = await t.run("CloseAccount", CLOSE);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("A human refused this call.");
  });

  it("fails closed when the approval store fails on create", async () => {
    const t = setup();
    t.flags.failCreate = true;
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("10.1.2.3");
    expect(t.calls).toHaveLength(0);
    expect(t.sleepLog).toHaveLength(0);
    expect(t.bank().accounts.find((x) => x.id === "4471")?.status).toBe("OPEN");
    const [entry] = t.entries();
    expect(entry).toMatchObject({ decision: "hold", outcome: "error" });
    expect(entry.approvalId).toBeUndefined();
  });

  it("fails closed when the approval store fails while polling", async () => {
    const t = setup();
    t.flags.failPoll = true;
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("10.1.2.3");
    expect(t.calls).toHaveLength(0);
    expect(t.entries()[0]).toMatchObject({ decision: "hold", outcome: "error" });
    expect(t.entries()[0].approvalId).toBeDefined();
  });

  it("reports an expired approval and sends nothing", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n === 1) t.advance(15 * 60_000);
      },
    });
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("This approval expired. Nothing was sent.");
    expect(t.calls).toHaveLength(0);
  });

  it("does not execute when a rule turns to block after approval", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n !== 2) return;
        await decideOnly(t, "approve");
        const rule: Rule = {
          id: "late-block",
          operation: "CloseAccount",
          effect: "block",
          reason: "Closures are frozen",
        };
        expect((await t.registry.putRules(SERVICE_ID, [rule])).ok).toBe(true);
      },
    });
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Closures are frozen");
    expect(t.calls).toHaveLength(0);
    expect(t.bank().accounts.find((x) => x.id === "4471")?.status).toBe("OPEN");
    const a = await onlyApproval(t);
    expect(a.status).toBe("executed"); // claimed and consumed, never retried
    expect(t.entries()[0]).toMatchObject({ decision: "block", outcome: "blocked", ruleId: "late-block", approvalId: a.id });
  });

  it("returns the ghost result when ghost mode is switched on after approval", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n !== 2) return;
        await decideOnly(t, "approve");
        await enableGhost(t);
      },
    });
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBeUndefined();
    expect(textOf(res).startsWith(GHOST_PREFIX)).toBe(true);
    expect(res.structuredContent?.ghost).toBe(true);
    expect(t.calls).toHaveLength(0);
    expect(t.bank().accounts.find((x) => x.id === "4471")?.status).toBe("OPEN");
    expect(t.entries()[0]).toMatchObject({ decision: "ghost", outcome: "ghost" });
  });

  it("attempts an approved call once: an upstream failure is returned and the approval is executed", async () => {
    const t: Harness = setup(
      async () => ({ ok: false, error: { code: "TIMEOUT", message: "detail xyz" } }),
      {
        human: async (n) => {
          if (n === 1) await decideOnly(t, "approve");
        },
      },
    );
    const res = await t.run("CloseAccount", CLOSE);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("The spirit did not answer.");
    expect(t.calls).toHaveLength(1);
    const a = await onlyApproval(t);
    expect(a.status).toBe("executed");
    expect(await t.approvals.claimExecution(SERVICE_ID, a.id)).toBe(false);
    expect(t.entries()[0]).toMatchObject({ outcome: "error", approvalId: a.id });
  });

  it("returns a claimed result without calling upstream when the claim is already taken", async () => {
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n !== 1) return;
        await decideOnly(t, "approve");
        const a = await onlyApproval(t);
        expect(await t.approvals.claimExecution(SERVICE_ID, a.id)).toBe(true); // another caller wins
      },
    });
    const res = await t.run("CloseAccount", CLOSE);

    const a = await onlyApproval(t);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ status: "claimed", approvalId: a.id });
    expect(textOf(res)).toContain("check_approval");
    expect(t.calls).toHaveLength(0);
    expect(t.entries()[0]).toMatchObject({ outcome: "held", approvalId: a.id });
  });

  it("keeps argument values and upstream text out of every hold-path summary", async () => {
    const rule: Rule = {
      id: "big-transfer",
      operation: "TransferFunds",
      when: { field: "amount", op: "gt", value: 50 },
      effect: "hold",
      reason: "held by test",
    };
    const t: Harness = setup(undefined, {
      human: async (n) => {
        if (n === 1) await decideOnly(t, "approve");
      },
    });
    expect((await t.registry.putRules(SERVICE_ID, [rule])).ok).toBe(true);
    const res = await t.run("TransferFunds", { fromAccount: "4471", toAccount: "5530", amount: 987654 });
    expect(res.isError).toBe(true); // "Insufficient funds" fault, produced by the real handler

    const a = await onlyApproval(t);
    const [entry] = t.entries();
    expect(entry.approvalId).toBe(a.id);
    expect(entry.outcome).toBe("fault");
    expect(entry.summary).toBe("TransferFunds: the service returned a fault");
    for (const e of t.entries()) {
      expect(e.summary).not.toContain("987654");
      expect(e.summary).not.toContain("4471");
      expect(e.summary).not.toContain("Insufficient");
    }
  });
});

describe("pipeline: check_approval", () => {
  const ALL_TOOLS: ToolDef[] = [];
  beforeAll(() => {
    ALL_TOOLS.push(...tools.values());
  });
  const check = (t: Harness, approvalId: unknown, svc: ServiceDefinition = service, ip = "203.0.113.9") =>
    t.pipeline.runCheckApproval({ service: svc, tools: ALL_TOOLS, approvalId, clientIp: ip });
  const closedStatus = (t: Harness) => t.bank().accounts.find((x) => x.id === "4471")?.status;

  /** Holds a CloseAccount call (no decision within 20 s) and returns its approval id. */
  async function held(t: Harness): Promise<string> {
    const res = await t.run("CloseAccount", CLOSE);
    expect(res.structuredContent?.status).toBe("held");
    return (await onlyApproval(t)).id;
  }

  it("executes once after a late approval, then reports already executed without a second call", async () => {
    const t = setup();
    const id = await held(t);
    expect(t.calls).toHaveLength(0);
    await decideOnly(t, "approve");

    const first = await check(t, id);
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({ closed: true });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body).toContain("4471");
    expect(closedStatus(t)).toBe("CLOSED");

    const second = await check(t, id);
    expect(second.isError).toBeUndefined();
    expect(textOf(second)).toBe("This call was already executed.");
    expect(t.calls).toHaveLength(1);
  });

  it("returns the held result again while the approval is pending", async () => {
    const t = setup();
    const id = await held(t);
    const a = await onlyApproval(t);

    const res = await check(t, id);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ status: "held", approvalId: id, expiresAt: a.expiresAt });
    expect(t.calls).toHaveLength(0);
  });

  it("returns the refusal with the sanitized note when denied", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "deny", "Not today\u200b");

    const res = await check(t, id);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("A human refused this call. Not today");
    expect(t.calls).toHaveLength(0);
  });

  it("reports an approval that passed its 15 minute expiry and never sends", async () => {
    const t = setup();
    const id = await held(t);
    t.advance(15 * 60_000);

    const res = await check(t, id);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("This approval expired. Nothing was sent.");
    expect(t.calls).toHaveLength(0);
    expect(closedStatus(t)).toBe("OPEN");
  });

  it("treats another service's approval id exactly like an unknown id", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    const other: ServiceDefinition = { ...service, id: "Zzzz9999" };

    const cross = await check(t, id, other);
    const unknown = await check(t, "does-not-exist", other);
    expect(cross.isError).toBe(true);
    expect(textOf(cross)).toBe("Approval not found.");
    expect(cross).toEqual(unknown);
    expect(t.calls).toHaveLength(0);
    expect(closedStatus(t)).toBe("OPEN");
  });

  it("rejects malformed approval ids without touching the store or upstream", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    const bad: unknown[] = ["", "a".repeat(65), "has space", "a/b", `${id}\n`, "é", 123, null, undefined, {}, [id]];
    for (const [i, b] of bad.entries()) {
      const res = await check(t, b, service, `198.51.100.${i + 1}`); // distinct IPs: stay under the rate limit
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe("Invalid approvalId.");
    }
    expect(t.calls).toHaveLength(0);
    expect((await t.approvals.getApproval(SERVICE_ID, id))?.status).toBe("approved");
  });

  it("does not execute when a rule turns to block after approval", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    const rule: Rule = { id: "late-block", operation: "CloseAccount", effect: "block", reason: "Closures are frozen" };
    expect((await t.registry.putRules(SERVICE_ID, [rule])).ok).toBe(true);

    const res = await check(t, id);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Closures are frozen");
    expect(t.calls).toHaveLength(0);
    expect(closedStatus(t)).toBe("OPEN");
  });

  it("returns the ghost result when ghost mode is on after approval", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    await enableGhost(t);

    const res = await check(t, id);
    expect(res.isError).toBeUndefined();
    expect(textOf(res).startsWith(GHOST_PREFIX)).toBe(true);
    expect(res.structuredContent?.ghost).toBe(true);
    expect(t.calls).toHaveLength(0);
    expect(closedStatus(t)).toBe("OPEN");
  });

  it("attempts an approved call once: an upstream failure is returned and a second check does not retry", async () => {
    const t = setup(async () => ({ ok: false, error: { code: "TIMEOUT", message: "detail xyz" } }));
    const id = await held(t);
    await decideOnly(t, "approve");

    const first = await check(t, id);
    expect(first.isError).toBe(true);
    expect(textOf(first)).toBe("The spirit did not answer.");
    expect(t.calls).toHaveLength(1);
    expect((await t.approvals.getApproval(SERVICE_ID, id))?.status).toBe("executed");

    const second = await check(t, id);
    expect(textOf(second)).toBe("This call was already executed.");
    expect(t.calls).toHaveLength(1);
  });

  it("returns a tool error and sends nothing when the approval store fails", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    t.flags.failPoll = true;

    const res = await check(t, id);
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("10.1.2.3");
    expect(t.calls).toHaveLength(0);
  });

  it("rate limits check_approval per client IP like runCall", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) expect(textOf(await check(t, "nope", service, "198.51.100.7"))).toBe("Approval not found.");
    const res = await check(t, "nope", service, "198.51.100.7");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Too many calls");
  });

  it("records every check with approvalId and tool check_approval, and no argument values", async () => {
    const t = setup();
    const id = await held(t);
    await decideOnly(t, "approve");
    await check(t, id);
    await check(t, id);
    await check(t, "unknown-id");

    const checks = t.entries().filter((e) => e.tool === "check_approval");
    expect(checks).toHaveLength(3);
    // The transcript list is newest first.
    expect(checks.map((e) => e.approvalId)).toEqual(["unknown-id", id, id]);
    for (const e of checks) {
      expect(e.args).toBeNull();
      expect(e.summary).not.toContain("4471");
      expect(e.summary).not.toContain(id);
    }
    expect(checks[2]).toMatchObject({ outcome: "ok", decision: "hold", summary: "CloseAccount: ok" });
    expect(checks[1].summary).toBe("check_approval: already executed, nothing was sent by this call");
    expect(checks[0].summary).toBe("check_approval: approval not found, nothing was sent");
    expect(checks[1]).toMatchObject({ outcome: "held", decision: "hold" });
  });
});
