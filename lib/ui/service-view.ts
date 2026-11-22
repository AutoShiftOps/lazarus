// lib/ui/service-view.ts
// Pure view model for the service page. Every string that came from a WSDL is
// untrusted and is sanitised here, once, so components can render it as plain text.

import { CHECK_APPROVAL_TOOL, sanitizeText, sanitizeToolName } from "../mcp/tools";
import { publicDefinition } from "../owner-token";
import { isServiceId } from "../registry/ids";
import type { FieldDescriptor, Risk, ServiceDefinition } from "../soap/types";

export const MAX_DESCRIPTION_CHARS = 140;
export const MAX_SERVICE_NAME_CHARS = 80;
const MAX_OPERATION_NAME_CHARS = 120;
const MAX_PORT_NAME_CHARS = 80;
const MAX_REASON_CHARS = 120;
const MAX_SLUG_CHARS = 40;
const DEFAULT_SLUG = "lazarus-service";

export type SpiritView = {
  /** The MCP tool name for this operation, as `buildTools` names it. */
  toolName: string;
  /** Public input fields. Names are kept exact because they are the argument keys; render as text only. */
  inputDescriptor: FieldDescriptor[];
  name: string;
  port: string;
  description: string;
  risk: Risk;
  riskReason: string;
};

export type ServiceView = {
  id: string;
  name: string;
  operationCount: number;
  mcpUrl: string;
  spirits: SpiritView[];
  clientConfigJson: string;
  cliCommand: string;
};

export type ServiceViewErrorCode = "INVALID_ID" | "INVALID_ORIGIN";

/** Thrown for an id or origin that must not be turned into a URL. The page maps it to not-found. */
export class ServiceViewError extends Error {
  readonly code: ServiceViewErrorCode;

  constructor(code: ServiceViewErrorCode, message: string) {
    super(message);
    this.name = "ServiceViewError";
    this.code = code;
  }
}

/** Returns the canonical origin when `origin` is exactly an http(s) origin, otherwise null. */
export function parseHttpOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.origin !== origin) return null;
  return url.origin;
}

/** Lowercase [a-z0-9-] slug, at most 40 characters, never empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return slug === "" ? DEFAULT_SLUG : slug;
}

/** Strips control and format characters from an untrusted service name and caps it at 80 characters. */
export function cleanServiceName(name: unknown): string {
  return sanitizeText(name, MAX_SERVICE_NAME_CHARS);
}

/**
 * Readable form of a service name: splits camelCase and PascalCase boundaries into words
 * and keeps acronym runs together ("SOAPService" becomes "SOAP Service"). Only adds spaces.
 */
export function displayName(name: string): string {
  return name
    .replace(/(\p{Ll}|\p{N})(?=\p{Lu})/gu, "$1 ")
    .replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, "$1 ");
}

function describeOperation(name: string, documentation: unknown): string {
  const doc = sanitizeText(documentation, MAX_DESCRIPTION_CHARS);
  if (doc !== "") return doc;
  const label = name === "" ? "This" : name;
  return sanitizeText(`${label} is an operation of the legacy service.`, MAX_DESCRIPTION_CHARS);
}

/** Copies only the known descriptor fields, so nothing else from a stored definition reaches the client. */
function copyDescriptor(fields: FieldDescriptor[]): FieldDescriptor[] {
  return fields.map((f) => ({
    name: f.name,
    xsdType: f.xsdType,
    minOccurs: f.minOccurs,
    maxOccurs: f.maxOccurs,
    nillable: f.nillable,
    ...(f.children ? { children: copyDescriptor(f.children) } : {}),
  }));
}

export function toServiceView(def: ServiceDefinition, origin: string): ServiceView {
  const id = def.id;
  if (typeof id !== "string" || !isServiceId(id)) {
    throw new ServiceViewError("INVALID_ID", "Invalid service id.");
  }
  const safeOrigin = parseHttpOrigin(origin);
  if (safeOrigin === null) {
    throw new ServiceViewError("INVALID_ORIGIN", "Invalid origin.");
  }

  // Only fields picked below can reach the output, and the hash is dropped first anyway.
  const pub = publicDefinition(def);
  const name = cleanServiceName(pub.name);
  const mcpUrl = `${safeOrigin}/api/mcp/${id}`;
  const slug = slugify(name);

  // Same order and reserved name as buildTools, so toolName matches the live MCP tool.
  const takenToolNames = new Set<string>([CHECK_APPROVAL_TOOL]);
  const spirits: SpiritView[] = [];
  for (const port of pub.ports) {
    const portName = sanitizeText(port.name, MAX_PORT_NAME_CHARS);
    for (const op of port.operations) {
      const opName = sanitizeText(op.name, MAX_OPERATION_NAME_CHARS);
      spirits.push({
        toolName: sanitizeToolName(op.name, takenToolNames),
        inputDescriptor: copyDescriptor(op.inputDescriptor),
        name: opName,
        port: portName,
        description: describeOperation(opName, op.documentation),
        risk: op.risk,
        riskReason: sanitizeText(op.riskReason, MAX_REASON_CHARS),
      });
    }
  }

  return {
    id,
    name,
    operationCount: spirits.length,
    mcpUrl,
    spirits,
    clientConfigJson: JSON.stringify({ mcpServers: { [slug]: { url: mcpUrl } } }, null, 2),
    cliCommand: `claude mcp add --transport http ${slug} ${mcpUrl}`,
  };
}
