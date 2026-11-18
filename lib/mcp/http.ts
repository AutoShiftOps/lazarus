// lib/mcp/http.ts
// Request handling for /api/mcp/{id} (Requirements 1.1-1.4, 1.6, 9.3). The route file stays thin and calls this.
// Stateless: a fresh Server and transport are created for every POST and closed afterwards.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { publicDefinition } from "../owner-token";
import { isServiceId, type Registry } from "../registry";
import type { ServiceDefinition } from "../soap/types";
import type { Deps } from "./pipeline";
import { createServerFor } from "./server";

export type McpHttpDeps = Omit<Deps, "registry"> & {
  registry: Pick<Registry, "getService" | "getRules" | "getSettings">;
};

export const MAX_BODY_BYTES = 256 * 1024;

const MSG_NOT_FOUND = "Service not found.";
const MSG_TOO_LARGE = "Request body is too large (limit 256 KB).";
const MSG_UNAVAILABLE = "The registry is temporarily unavailable.";
const MSG_INTERNAL = "Something went wrong inside Lazarus. Nothing was sent.";
const MSG_PARSE = "Parse error: the request body is not valid JSON.";
const MSG_METHOD = "Method not allowed. Use POST.";

const ALLOW = "POST, OPTIONS";

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function rpcError(status: number, code: number, message: string, extra?: Record<string, string>): Response {
  return withCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "content-type": "application/json", ...extra },
    }),
  );
}

export function methodNotAllowed(): Response {
  return rpcError(405, -32000, MSG_METHOD, { Allow: ALLOW });
}

export function handleOptions(): Response {
  return withCors(new Response(null, { status: 204 }));
}

function clientIpOf(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first : "unknown";
}

function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

export async function handleMcpRequest(request: Request, id: string, deps: McpHttpDeps): Promise<Response> {
  try {
    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "POST") return methodNotAllowed();

    if (!isServiceId(id)) return rpcError(404, -32001, MSG_NOT_FOUND);

    const declared = declaredLength(request);
    if (declared !== undefined && declared > MAX_BODY_BYTES) return rpcError(413, -32600, MSG_TOO_LARGE);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return rpcError(413, -32600, MSG_TOO_LARGE);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcError(400, -32700, MSG_PARSE);
    }

    const found = await deps.registry.getService(id);
    if (!found.ok) {
      console.error("mcp http: registry unavailable");
      return rpcError(503, -32002, MSG_UNAVAILABLE);
    }
    if (found.value === null) return rpcError(404, -32001, MSG_NOT_FOUND);

    // The owner token hash must never reach the server, the tools or any response.
    const service: ServiceDefinition = { ...publicDefinition(found.value), id };

    const server = createServerFor(service, deps, { clientIp: clientIpOf(request) });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(request, { parsedBody: body });
      return withCors(res);
    } finally {
      try {
        await server.close();
      } catch {
        console.error("mcp http: close failed");
      }
    }
  } catch {
    console.error("mcp http: unexpected failure");
    return rpcError(500, -32603, MSG_INTERNAL);
  }
}
