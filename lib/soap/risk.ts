// lib/soap/risk.ts
// Operation risk classification. The heuristic is pure; the optional model can only raise a class.

import { z } from "zod";
import type { FieldDescriptor, OperationSchema, Risk } from "./types";

const READ_TOKENS = new Set([
  "get", "list", "find", "search", "query", "read", "fetch", "lookup", "check", "validate", "describe", "count",
]);
const DESTRUCTIVE_WORDS = [
  "delete", "remove", "close", "cancel", "terminate", "revoke", "purge", "drop", "destroy", "void", "deactivate", "disable",
];
const DOC_DESTRUCTIVE = ["cannot be undone", "irreversible", "permanently", "delete"];

const MAX_REASON = 120;
const MAX_DOC = 500;
const DEFAULT_TIMEOUT_MS = 8000;

const RANK: Record<Risk, number> = { read: 0, write: 1, destructive: 2 };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

export function heuristicRisk(name: string, documentation?: string): { risk: Risk; reason: string } {
  const lower = name.toLowerCase();
  const word = DESTRUCTIVE_WORDS.find((w) => lower.includes(w));
  if (word !== undefined) {
    return { risk: "destructive", reason: clip(`Name contains "${word}".`, MAX_REASON) };
  }
  const readToken = tokenize(name).find((t) => READ_TOKENS.has(t));
  const base: Risk = readToken !== undefined ? "read" : "write";
  const docLower = (documentation ?? "").toLowerCase();
  const docWord = DOC_DESTRUCTIVE.find((w) => docLower.includes(w));
  if (docWord !== undefined) {
    return { risk: "destructive", reason: clip(`Documentation mentions "${docWord}".`, MAX_REASON) };
  }
  return base === "read"
    ? { risk: "read", reason: clip(`Name starts a read-only verb "${readToken}".`, MAX_REASON) }
    : { risk: "write", reason: "No read-only verb in the name; assumed to change data." };
}

export function mergeRisk(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

export type BedrockLike = {
  classify(
    input: { name: string; documentation?: string; fields: string[] }[],
    signal: AbortSignal,
  ): Promise<unknown>;
};

const ModelAnswerSchema = z.array(
  z.object({
    name: z.string(),
    risk: z.enum(["read", "write", "destructive"]),
    reason: z.string().max(300),
  }),
);

function fieldNames(fields: FieldDescriptor[], out: string[]): string[] {
  for (const f of fields) {
    out.push(f.name);
    if (f.children !== undefined) fieldNames(f.children, out);
  }
  return out;
}

function sanitiseReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return clip(cleaned, MAX_REASON);
}

function copyOp(op: OperationSchema): OperationSchema {
  return structuredClone(op);
}

export async function classifyOperations(
  ops: OperationSchema[],
  deps: { bedrock?: BedrockLike; timeoutMs?: number } = {},
): Promise<OperationSchema[]> {
  const result = ops.map(copyOp);
  const bedrock = deps.bedrock;
  if (bedrock === undefined || ops.length === 0) return result;

  const payload = ops.map((op) => {
    const entry: { name: string; documentation?: string; fields: string[] } = {
      name: op.name,
      fields: [...fieldNames(op.inputDescriptor, []), ...fieldNames(op.outputDescriptor, [])],
    };
    if (op.documentation !== undefined) entry.documentation = op.documentation.slice(0, MAX_DOC);
    return entry;
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answers: z.infer<typeof ModelAnswerSchema>;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    const raw = await Promise.race([bedrock.classify(payload, controller.signal), timeout]);
    const parsed = ModelAnswerSchema.safeParse(raw);
    if (!parsed.success) return result;
    answers = parsed.data;
  } catch {
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const byName = new Map<string, (typeof answers)[number]>();
  for (const a of answers) if (!byName.has(a.name)) byName.set(a.name, a);

  for (const op of result) {
    const answer = byName.get(op.name);
    if (answer === undefined) continue;
    if (mergeRisk(op.risk, answer.risk) !== answer.risk) continue;
    const reason = sanitiseReason(answer.reason);
    op.risk = answer.risk;
    if (reason !== "") op.riskReason = reason;
    op.riskSource = "model";
  }
  return result;
}
