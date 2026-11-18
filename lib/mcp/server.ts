// lib/mcp/server.ts
// One low-level MCP Server per request (Requirement 2). It is used instead of McpServer.registerTool so that
//   (a) tools/list returns each ToolDef.inputSchema exactly as buildTools produced it, and
//   (b) argument validation stays in our pipeline and fails as a tool error, not an SDK protocol error.
// The upstream service is only ever reached through pipeline.runCall / runCheckApproval.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceDefinition } from "../soap/types";
import { createPipeline, type Deps, type McpToolResult } from "./pipeline";
import { buildTools, CHECK_APPROVAL_TOOL, type ToolDef } from "./tools";

export type ServerContext = { clientIp: string };

const SERVER_NAME = "lazarus";
const SERVER_VERSION = "1.0.0";
const MSG_UNKNOWN_TOOL = "Unknown tool.";
const MSG_INTERNAL = "Something went wrong inside Lazarus. Nothing was sent.";

const CHECK_APPROVAL_DEF: Tool = {
  name: CHECK_APPROVAL_TOOL,
  description:
    "Collects the outcome of a call that was held for human approval. " +
    "Pass the approvalId from the held result. An approved call is executed at most once.",
  inputSchema: {
    type: "object",
    properties: { approvalId: { type: "string", description: "The approvalId returned for the held call." } },
    required: ["approvalId"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function toListedTool(t: ToolDef): Tool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: { ...t.inputSchema, type: "object" },
    annotations: t.annotations,
  };
}

/** Reads `approvalId` from untrusted arguments without trusting their shape. */
function approvalIdOf(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return (args as Record<string, unknown>).approvalId;
}

export function createServerFor(service: ServiceDefinition, deps: Deps, ctx: ServerContext): Server {
  const tools = buildTools(service);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const pipeline = createPipeline(deps);

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.map(toListedTool), CHECK_APPROVAL_DEF],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<McpToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      if (name === CHECK_APPROVAL_TOOL) {
        return await pipeline.runCheckApproval({
          service,
          tools,
          approvalId: approvalIdOf(args),
          clientIp: ctx.clientIp,
        });
      }
      const tool = byName.get(name);
      if (!tool) return errorResult(MSG_UNKNOWN_TOOL);
      return await pipeline.runCall({ service, tool, args: args ?? {}, clientIp: ctx.clientIp });
    } catch {
      console.error("mcp server: tool call failed");
      return errorResult(MSG_INTERNAL);
    }
  });

  return server;
}
