// lib/mcp/tools.ts
// Turns a ServiceDefinition into MCP tool definitions (Requirement 2).
// Pure: no I/O, no globals.

import { z } from "zod";
import { buildZodSchema } from "../soap/schema-generator";
import type { OperationSchema, Risk, ServiceDefinition } from "../soap/types";

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
};

export type ToolDef = {
  name: string;
  op: OperationSchema;
  port: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
};

const MAX_NAME = 64;
const MAX_DOC = 400;
const MAX_REASON = 120;
const MAX_DESCRIPTION = 1000;

/**
 * Sanitises a raw operation name into a unique MCP tool name.
 * Never throws; the result matches ^[A-Za-z0-9_-]{1,64}$ and is added to `taken`.
 */
export function sanitizeToolName(raw: string, taken: Set<string>): string {
  const cleaned = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9_-]/g, "_") : "";
  const base = (cleaned === "" ? "op" : cleaned).slice(0, MAX_NAME);

  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = base.slice(0, MAX_NAME - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

/**
 * Makes untrusted text safe for an agent-visible description: strips control,
 * format (zero-width, bidi) characters, collapses all whitespace to single
 * spaces, caps at `max` characters with an ellipsis and trims.
 */
export function sanitizeText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const text = input
    .replace(/[\t\n\v\f\r\u2028\u2029]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}

function annotationsFor(risk: Risk): ToolAnnotations {
  const a: ToolAnnotations = { openWorldHint: true };
  if (risk === "read") a.readOnlyHint = true;
  if (risk === "destructive") a.destructiveHint = true;
  if (risk !== "read") a.idempotentHint = false;
  return a;
}

function describe(op: OperationSchema): string {
  // The risk line is ours: risk is an enum, riskReason is capped defensively.
  const riskLine = `Risk: ${op.risk} — ${sanitizeText(op.riskReason, MAX_REASON)}`;
  const doc = sanitizeText(op.documentation, MAX_DOC);
  const body = doc !== "" ? doc : sanitizeText(op.name, MAX_DOC);
  return `${riskLine}\n\n${body}`.slice(0, MAX_DESCRIPTION);
}

/** One tool per operation across all ports (Requirements 2.1–2.5). */
export function buildTools(service: ServiceDefinition): ToolDef[] {
  const taken = new Set<string>();
  const tools: ToolDef[] = [];
  for (const port of service.ports) {
    for (const op of port.operations) {
      tools.push({
        name: sanitizeToolName(op.name, taken),
        op,
        port: port.name,
        description: describe(op),
        inputSchema: z.toJSONSchema(buildZodSchema(op.inputDescriptor)) as Record<string, unknown>,
        annotations: annotationsFor(op.risk),
      });
    }
  }
  return tools;
}
