import { describe, expect, it } from "vitest";
import { handleMcpRequest, MAX_BODY_BYTES, type McpHttpDeps } from "../../lib/mcp/http";
import type { RegistryResult } from "../../lib/registry";
import type { ServiceDefinition } from "../../lib/soap/types";

const ID = "Abcd1234Efgh";
const HASH = "f".repeat(64);
const REDIS_SECRET = "redis-connection-refused-secret-host.internal:6379";

const SERVICE: ServiceDefinition = {
  name: "Stub",
  wsdlUrl: "https://example.com/stub?wsdl",
  ports: [],
  warnings: [],
  ownerTokenHash: HASH,
};

type Calls = { getService: string[] };

function makeDeps(getService: (id: string) => Promise<RegistryResult<ServiceDefinition | null>>): {
  deps: McpHttpDeps;
  calls: Calls;
} {
  const calls: Calls = { getService: [] };
  const unused = (): never => {
    throw new Error("dependency must not be used by these tests");
  };
  const deps: McpHttpDeps = {
    registry: {
      getService: (id) => {
        calls.getService.push(id);
        return getService(id);
      },
      getRules: unused,
      getSettings: unused,
    },
    transcripts: { appendTranscript: unused },
    approvals: {
      create: unused,
      get: unused,
      decide: unused,
      claim: unused,
      listPending: unused,
    } as unknown as McpHttpDeps["approvals"],
    post: unused,
    rateRedis: {
      incr: unused,
      expire: unused,
      ttl: unused,
    } as unknown as McpHttpDeps["rateRedis"],
    now: () => 0,
    sleep: () => Promise.resolve(),
    newId: () => "id",
  };
  return { deps, calls };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/mcp/${ID}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
  });
}

const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

type RpcError = { jsonrpc: string; error: { code: number; message: string }; id: unknown };

async function rpcErrorOf(res: Response): Promise<RpcError> {
  return (await res.json()) as RpcError;
}

function expectCors(res: Response): void {
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  expect(res.headers.get("access-control-allow-headers")).toBe(
    "content-type, accept, mcp-protocol-version, mcp-session-id",
  );
  expect(res.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0);
}

describe("handleMcpRequest", () => {
  it("rejects a malformed id with JSON-RPC 404 and makes no registry call", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    for (const bad of ["short", "has space!", "a".repeat(13), "../etc/passwd", ""]) {
      const res = await handleMcpRequest(post(LIST), bad, deps);
      expect(res.status).toBe(404);
      const body = await rpcErrorOf(res);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeNull();
      expect(typeof body.error.code).toBe("number");
      expectCors(res);
    }
    expect(calls.getService).toEqual([]);
  });

  it("returns 413 when content-length declares an oversized body, without reading the registry", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const res = await handleMcpRequest(post(LIST, { "content-length": String(MAX_BODY_BYTES + 1) }), ID, deps);
    expect(res.status).toBe(413);
    expect((await rpcErrorOf(res)).error.message).toMatch(/too large/i);
    expectCors(res);
    expect(calls.getService).toEqual([]);
  });

  it("returns 413 when the actual body is oversized", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    const res = await handleMcpRequest(post(big), ID, deps);
    expect(res.status).toBe(413);
    expectCors(res);
    expect(calls.getService).toEqual([]);
  });

  it("counts bytes, not characters, for the size cap", async () => {
    const { deps } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    // 3-byte characters: character count stays under the cap, byte length goes over.
    const big = JSON.stringify({ pad: "€".repeat(MAX_BODY_BYTES / 3) });
    expect(big.length).toBeLessThan(MAX_BODY_BYTES);
    const res = await handleMcpRequest(post(big), ID, deps);
    expect(res.status).toBe(413);
  });

  it("returns 503 with fixed text and never leaks the registry error", async () => {
    const { deps } = makeDeps(() =>
      Promise.resolve({
        ok: false,
        error: { code: "REGISTRY_UNAVAILABLE", message: REDIS_SECRET, detail: REDIS_SECRET },
      }),
    );
    const res = await handleMcpRequest(post(LIST), ID, deps);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(REDIS_SECRET);
    const body = JSON.parse(text) as RpcError;
    expect(body.error.message).toBe("The registry is temporarily unavailable.");
    expect(body.id).toBeNull();
    expectCors(res);
  });

  it("returns 404 when the service does not exist", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: null }));
    const res = await handleMcpRequest(post(LIST), ID, deps);
    expect(res.status).toBe(404);
    expect((await rpcErrorOf(res)).error.message).toBe("Service not found.");
    expect(calls.getService).toEqual([ID]);
    expectCors(res);
  });

  it("returns 400 with a JSON-RPC parse error for invalid JSON", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const res = await handleMcpRequest(post("{not json"), ID, deps);
    expect(res.status).toBe(400);
    expect((await rpcErrorOf(res)).error.code).toBe(-32700);
    expect(calls.getService).toEqual([]);
  });

  it("answers GET and DELETE with 405 and an Allow header", async () => {
    const { deps, calls } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcpRequest(new Request(`http://localhost/api/mcp/${ID}`, { method }), ID, deps);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST, OPTIONS");
      expect((await rpcErrorOf(res)).jsonrpc).toBe("2.0");
      expectCors(res);
    }
    expect(calls.getService).toEqual([]);
  });

  it("answers OPTIONS with 204 and CORS headers", async () => {
    const { deps } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const res = await handleMcpRequest(new Request(`http://localhost/api/mcp/${ID}`, { method: "OPTIONS" }), ID, deps);
    expect(res.status).toBe(204);
    expectCors(res);
  });

  it("turns an unexpected throw into a fixed 500", async () => {
    const { deps } = makeDeps(() => Promise.reject(new Error(REDIS_SECRET)));
    const res = await handleMcpRequest(post(LIST), ID, deps);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(REDIS_SECRET);
    expect((JSON.parse(text) as RpcError).error.message).toBe(
      "Something went wrong inside Lazarus. Nothing was sent.",
    );
    expectCors(res);
  });

  it("serves tools/list with CORS and never exposes ownerTokenHash", async () => {
    const { deps } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const res = await handleMcpRequest(post(LIST), ID, deps);
    expect(res.status).toBe(200);
    expectCors(res);
    const text = await res.text();
    expect(text).not.toContain(HASH);
    expect(text).not.toContain("ownerTokenHash");
    const body = JSON.parse(text) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toContain("check_approval");
  });

  it("never exposes ownerTokenHash in any error response", async () => {
    const { deps } = makeDeps(() => Promise.resolve({ ok: true, value: SERVICE }));
    const responses = [
      await handleMcpRequest(post(LIST), "bad", deps),
      await handleMcpRequest(post("{"), ID, deps),
      await handleMcpRequest(new Request(`http://localhost/x`, { method: "GET" }), ID, deps),
    ];
    for (const res of responses) expect(await res.text()).not.toContain(HASH);
  });
});
