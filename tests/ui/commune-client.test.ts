import { describe, expect, it } from "vitest";
import { callTool, collectResult, COMMUNE_MESSAGES } from "../../lib/ui/commune-client";

type Captured = { url: string; init: RequestInit | undefined };

function rpcResult(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResult(text: string, extra: Record<string, unknown> = {}): unknown {
  return { content: [{ type: "text", text }], ...extra };
}

function fetchReturning(res: Response | (() => Promise<Response>)): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return typeof res === "function" ? res() : res.clone();
    },
  };
}

describe("callTool", () => {
  it("posts a JSON-RPC tools/call with the agent headers", async () => {
    const f = fetchReturning(rpcResult(textResult("{}", { structuredContent: { a: 1 } })));
    await callTool("abcd1234", "Add", { x: 1 }, { fetch: f.fetch });
    expect(f.calls[0].url).toBe("/api/mcp/abcd1234");
    expect(f.calls[0].init?.method).toBe("POST");
    expect(f.calls[0].init?.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    const body = JSON.parse(String(f.calls[0].init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "Add", arguments: { x: 1 } },
    });
  });

  it("maps a structured success to ok", async () => {
    const f = fetchReturning(rpcResult(textResult("{}", { structuredContent: { sum: 3 } })));
    expect(await callTool("s", "Add", {}, { fetch: f.fetch })).toEqual({ kind: "ok", data: { sum: 3 } });
  });

  it("falls back to the text for an oversized ok result", async () => {
    const f = fetchReturning(rpcResult(textResult('{"big":\n[result truncated]')));
    expect(await callTool("s", "Add", {}, { fetch: f.fetch })).toEqual({
      kind: "ok",
      data: '{"big":\n[result truncated]',
    });
  });

  it("maps a held result", async () => {
    const f = fetchReturning(
      rpcResult(
        textResult("held", { structuredContent: { status: "held", approvalId: "ap1", expiresAt: "2030-01-01T00:00:00Z" } }),
      ),
    );
    expect(await callTool("s", "Close", {}, { fetch: f.fetch })).toEqual({
      kind: "held",
      approvalId: "ap1",
      expiresAt: "2030-01-01T00:00:00Z",
    });
  });

  it("maps blocked texts from the pipeline", async () => {
    const f = fetchReturning(rpcResult(textResult("A human refused this call. no", { isError: true })));
    expect(await callTool("s", "Close", {}, { fetch: f.fetch })).toEqual({
      kind: "blocked",
      message: "A human refused this call. no",
    });
  });

  it("maps a custom rule reason with the blocked status to blocked, not fault", async () => {
    const reason = "Transfers over 1000 are blocked";
    const f = fetchReturning(
      rpcResult(textResult(reason, { isError: true, structuredContent: { status: "blocked", reason } })),
    );
    expect(await callTool("s", "Transfer", {}, { fetch: f.fetch })).toEqual({ kind: "blocked", message: reason });
  });

  it("keeps a plain isError text without the status as a fault", async () => {
    const f = fetchReturning(rpcResult(textResult("Transfers over 1000 are blocked", { isError: true })));
    expect(await callTool("s", "Transfer", {}, { fetch: f.fetch })).toEqual({
      kind: "fault",
      message: "Transfers over 1000 are blocked",
    });
  });

  it("maps a ghost result with its marker", async () => {
    const f = fetchReturning(
      rpcResult(textResult("[GHOST — x]\n{}", { structuredContent: { ghost: true, result: { closed: true } } })),
    );
    expect(await callTool("s", "Close", {}, { fetch: f.fetch })).toEqual({ kind: "ghost", data: { closed: true } });
  });

  it("maps an oversized ghost result from its text prefix", async () => {
    const f = fetchReturning(rpcResult(textResult("[GHOST — nothing was sent to the real service]\n{\"a\":")));
    expect(await callTool("s", "Close", {}, { fetch: f.fetch })).toEqual({ kind: "ghost", data: '{"a":' });
  });

  it("maps a tool error to fault with its text", async () => {
    const f = fetchReturning(rpcResult(textResult("Invalid arguments. a: required", { isError: true })));
    expect(await callTool("s", "Add", {}, { fetch: f.fetch })).toEqual({
      kind: "fault",
      message: "Invalid arguments. a: required",
    });
  });

  it("maps the pipeline rate-limit text and HTTP 429 to rate_limited", async () => {
    const a = fetchReturning(rpcResult(textResult("Too many calls", { isError: true })));
    expect(await callTool("s", "Add", {}, { fetch: a.fetch })).toEqual({ kind: "rate_limited" });
    const b = fetchReturning(new Response("{}", { status: 429 }));
    expect(await callTool("s", "Add", {}, { fetch: b.fetch })).toEqual({ kind: "rate_limited" });
  });

  it("maps HTTP 503, 413, network errors and JSON-RPC errors to fixed messages", async () => {
    const a = fetchReturning(new Response("secret server text", { status: 503 }));
    expect(await callTool("s", "Add", {}, { fetch: a.fetch })).toEqual({ kind: "unavailable" });

    const b = fetchReturning(new Response("secret server text", { status: 413 }));
    expect(await callTool("s", "Add", {}, { fetch: b.fetch })).toEqual({
      kind: "fault",
      message: COMMUNE_MESSAGES.too_large,
    });

    const c = fetchReturning(() => Promise.reject(new TypeError("boom")));
    expect(await callTool("s", "Add", {}, { fetch: c.fetch })).toEqual({ kind: "unavailable" });

    const d = fetchReturning(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "secret" } }), {
        status: 200,
      }),
    );
    expect(await callTool("s", "Add", {}, { fetch: d.fetch })).toEqual({
      kind: "fault",
      message: COMMUNE_MESSAGES.rpc_error,
    });
  });

  it("rejects when the signal aborts", async () => {
    const controller = new AbortController();
    const f = fetchReturning(
      () => new Promise<Response>((_, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))),
    );
    const pending = callTool("s", "Add", {}, { fetch: f.fetch, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("collectResult", () => {
  it("calls check_approval with the approval id and maps the result", async () => {
    const f = fetchReturning(rpcResult(textResult("{}", { structuredContent: { closed: true } })));
    const out = await collectResult("abcd1234", "ap1", { fetch: f.fetch });
    expect(out).toEqual({ kind: "ok", data: { closed: true } });
    const body = JSON.parse(String(f.calls[0].init?.body)) as { params: unknown };
    expect(body.params).toEqual({ name: "check_approval", arguments: { approvalId: "ap1" } });
  });

  it("returns held while the approval is still pending", async () => {
    const f = fetchReturning(
      rpcResult(textResult("held", { structuredContent: { status: "held", approvalId: "ap1", expiresAt: "e" } })),
    );
    expect(await collectResult("s", "ap1", { fetch: f.fetch })).toEqual({
      kind: "held",
      approvalId: "ap1",
      expiresAt: "e",
    });
  });
});
