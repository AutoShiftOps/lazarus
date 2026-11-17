// lib/summon/index.ts
// Summon pipeline: fetch -> parse -> generate schemas -> register. The route file is a thin wrapper.

import { z } from "zod";
import { fetchWsdl } from "../soap/fetcher";
import { parseWsdl } from "../soap/parser";
import { generateSchemas } from "../soap/schema-generator";
import { upsertService } from "../registry";
import type {
  BindingStyle,
  ErrorCode,
  OperationSchema,
  ServiceDefinition,
  SoapVersion,
  Warning,
} from "../soap/types";

export const MAX_BODY_BYTES = 4096;
export const MAX_URL_LENGTH = 2048;
const MAX_OPERATIONS = 500;
const MAX_WARNINGS = 49;
const MAX_ERROR_LENGTH = 500;

export const MSG_INVALID_URL = "Invalid URL — only HTTP and HTTPS are supported.";
const MSG_INVALID_BODY = 'Request body must be JSON of the form {"wsdlUrl": "<url>"}.';
const MSG_BODY_TOO_LARGE = "Request body is too large.";
const MSG_URL_TOO_LONG = "The WSDL URL is too long (maximum 2048 characters).";
const MSG_INTERNAL = "An unexpected error occurred.";

export const SummonRequestSchema = z.object({ wsdlUrl: z.string().url() }).strict();

export type SummonResponse = { status: number; body: unknown };

type FetchOutcome = Awaited<ReturnType<typeof fetchWsdl>>;
type ParseOutcome = Awaited<ReturnType<typeof parseWsdl>>;
type UpsertOutcome = Awaited<ReturnType<typeof upsertService>>;

export type SummonDeps = {
  fetchWsdl: (url: string) => Promise<FetchOutcome>;
  parseWsdl: (xml: string, deps?: { baseUrl?: string }) => Promise<ParseOutcome>;
  generateSchemas: (service: ServiceDefinition) => Map<string, OperationSchema>;
  upsertService: (def: ServiceDefinition) => Promise<UpsertOutcome>;
};

const defaultDeps: SummonDeps = { fetchWsdl, parseWsdl, generateSchemas, upsertService };

/** Client-facing code and HTTP status for each internal error code. TIMEOUT is shown as WSDL_FETCH_FAILED (design.md). */
const ERROR_MAP: Record<ErrorCode, { status: number; code: ErrorCode }> = {
  INVALID_REQUEST: { status: 400, code: "INVALID_REQUEST" },
  SSRF_BLOCKED: { status: 400, code: "SSRF_BLOCKED" },
  WSDL_TOO_LARGE: { status: 422, code: "WSDL_TOO_LARGE" },
  WSDL_PARSE_FAILED: { status: 422, code: "WSDL_PARSE_FAILED" },
  WSDL_FETCH_FAILED: { status: 502, code: "WSDL_FETCH_FAILED" },
  TIMEOUT: { status: 504, code: "WSDL_FETCH_FAILED" },
  REGISTRY_UNAVAILABLE: { status: 503, code: "REGISTRY_UNAVAILABLE" },
  INTERNAL_ERROR: { status: 500, code: "INTERNAL_ERROR" },
};

const URL_PATTERN = /https?:\/\/\S+/gi;
// Private-use characters delimit URL placeholders. They are removed from input so user text cannot collide.
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const PH_STRIP = /[\uE000\uE001]/g;
const PH_RESTORE = /\uE000(\d+)\uE001/g;
// A filesystem path ending in a source extension. The leading class also covers placeholders,
// so a path fragment glued to a URL placeholder is removed together with it.
const SOURCE_PATH = /[^\s"'<>()[\]]*[\\/][\w.-]+\.(?:ts|js|mjs|cjs)\b(?::\d+)*/gi;
const NODE_MODULES_PATH = /[^\s"'<>()[\]]*node_modules[^\s"'<>()[\]]*/g;
const STACK_TAIL = /(?:^|\r?\n)[ \t]*at\s[\s\S]*$|[ \t]{4}at\s[\s\S]*$/;

/** One pass: mask URLs, strip unsafe text from the masked text, restore URLs, collapse, truncate. */
function sanitisePass(input: string): string {
  const urls: string[] = [];
  const masked = input
    .replace(PH_STRIP, "")
    .replace(URL_PATTERN, (url) => `${PH_OPEN}${urls.push(url) - 1}${PH_CLOSE}`);
  const stripped = masked
    .replace(STACK_TAIL, "")
    .replace(NODE_MODULES_PATH, "")
    .replace(SOURCE_PATH, "")
    .replace(/node_modules/g, "");
  const restored = stripped.replace(PH_RESTORE, (_m, i: string) => urls[Number(i)] ?? "");
  return restored
    .replace(/node_modules/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

/** True when the text satisfies the safety rules (URLs may contain paths). */
function isSafe(text: string): boolean {
  return (
    text.length <= MAX_ERROR_LENGTH &&
    !text.includes("    at ") &&
    !text.includes("node_modules") &&
    !/[\\/][\w.-]+\.(?:ts|js|mjs|cjs)\b/.test(text.replace(URL_PATTERN, ""))
  );
}

/** Removes stack frames and source paths, repeating until stable so removal cannot create new matches. */
function sanitiseMessage(message: string): string {
  let current = message;
  for (let i = 0; i < 5; i++) {
    const next = sanitisePass(current);
    if (next === current) break;
    current = next;
  }
  return isSafe(current) ? current : "";
}

function errorResponse(status: number, code: ErrorCode, message: string): SummonResponse {
  const error = sanitiseMessage(message) || MSG_INTERNAL;
  return { status, body: { error, code } };
}

function fromLazarusError(err: { code: ErrorCode; message: string }): SummonResponse {
  const mapped = ERROR_MAP[err.code] ?? ERROR_MAP.INTERNAL_ERROR;
  // detail is never forwarded. Internal errors always get the generic message.
  const message = mapped.code === "INTERNAL_ERROR" ? MSG_INTERNAL : err.message;
  return errorResponse(mapped.status, mapped.code, message);
}

type OperationSummary = {
  name: string;
  description?: string;
  bindingStyle: BindingStyle;
  soapVersions: SoapVersion[];
  warnings: Warning[];
};

function capWarnings(warnings: Warning[]): Warning[] {
  return warnings
    .slice(0, MAX_WARNINGS)
    .map((w) => ({ code: w.code, message: w.message.slice(0, 200) }));
}

function summarise(op: OperationSchema): OperationSummary {
  const summary: OperationSummary = {
    name: op.name,
    bindingStyle: op.bindingStyle,
    soapVersions: [...op.soapVersions],
    warnings: capWarnings(op.warnings),
  };
  const doc = (op as OperationSchema & { documentation?: unknown }).documentation;
  if (typeof doc === "string" && doc.length > 0) summary.description = doc.slice(0, 500);
  return summary;
}

/** Runs the summon pipeline. Never throws. */
export async function summon(
  wsdlUrl: string,
  origin: string,
  deps: Partial<SummonDeps> = {},
): Promise<SummonResponse> {
  const d: SummonDeps = { ...defaultDeps, ...deps };
  try {
    if (wsdlUrl.length > MAX_URL_LENGTH) {
      return errorResponse(400, "INVALID_REQUEST", MSG_URL_TOO_LONG);
    }
    let protocol: string;
    try {
      protocol = new URL(wsdlUrl).protocol;
    } catch {
      return errorResponse(400, "INVALID_REQUEST", MSG_INVALID_URL);
    }
    if (protocol !== "http:" && protocol !== "https:") {
      return errorResponse(400, "INVALID_REQUEST", MSG_INVALID_URL);
    }

    const fetched = await d.fetchWsdl(wsdlUrl);
    if (!fetched.ok) return fromLazarusError(fetched.error);

    const parsed = await d.parseWsdl(fetched.xml, { baseUrl: fetched.finalUrl });
    if (!parsed.ok) return fromLazarusError(parsed.error);

    const generated = d.generateSchemas(parsed.definition);
    // generateSchemas copies operations in port order; swap them in so warnings are persisted.
    const copies = generated.values();
    const ports = parsed.definition.ports.map((port) => ({
      ...port,
      operations: port.operations.map((original) => {
        const next = copies.next();
        return next.done ? original : next.value;
      }),
    }));
    // Keyed by the submitted URL so repeat summons dedupe even when the WSDL redirects.
    const definition: ServiceDefinition = { ...parsed.definition, ports, wsdlUrl };

    const stored = await d.upsertService(definition);
    if (!stored.ok) return fromLazarusError(stored.error);

    const operations = ports
      .flatMap((p) => p.operations)
      .slice(0, MAX_OPERATIONS)
      .map(summarise);

    return {
      status: 200,
      body: {
        id: stored.id,
        name: definition.name,
        operations,
        wsdlUrl,
        mcpUrl: `${origin}/api/mcp/${stored.id}`,
        warnings: capWarnings(definition.warnings),
      },
    };
  } catch (e) {
    console.error("summon failed:", e instanceof Error ? e.name : "unknown error");
    return errorResponse(500, "INTERNAL_ERROR", MSG_INTERNAL);
  }
}

/** Validates the raw request body text, then runs the pipeline. Never throws. */
export async function summonFromBody(
  rawBody: string,
  origin: string,
  deps?: Partial<SummonDeps>,
): Promise<SummonResponse> {
  try {
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return errorResponse(400, "INVALID_REQUEST", MSG_BODY_TOO_LARGE);
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", MSG_INVALID_BODY);
    }
    const parsed = SummonRequestSchema.safeParse(json);
    if (!parsed.success) {
      const urlIssue = parsed.error.issues.some(
        (i) => i.path[0] === "wsdlUrl" && i.code === "invalid_format",
      );
      return errorResponse(400, "INVALID_REQUEST", urlIssue ? MSG_INVALID_URL : MSG_INVALID_BODY);
    }
    return await summon(parsed.data.wsdlUrl, origin, deps);
  } catch (e) {
    console.error("summon request failed:", e instanceof Error ? e.name : "unknown error");
    return errorResponse(500, "INTERNAL_ERROR", MSG_INTERNAL);
  }
}
