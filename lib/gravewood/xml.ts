import { XMLParser, XMLValidator } from "fast-xml-parser";

export type ParsedRequest =
  | { ok: true; operation: string; params: Record<string, unknown> }
  | { ok: false; reason: "malformed" | "doctype" | "no-operation" };

export type XmlNode = {
  name: string;
  text?: string;
  nil?: boolean;
  children?: XmlNode[];
};

export const MAX_ECHO_ID = /^[0-9]{1,12}$/;

const ELEMENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const DOCTYPE_OR_ENTITY = /<!\s*(DOCTYPE|ENTITY)/i;
const MAX_FAULT_CHARS = 200;
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const BANK_NS = "urn:gravewood";

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreDeclaration: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that are not real child elements (text node, PI, comment markers). */
function isElementKey(k: string): boolean {
  return !k.startsWith("#") && !k.startsWith("?") && !k.startsWith("!");
}

export function parseRequest(xml: string): ParsedRequest {
  if (DOCTYPE_OR_ENTITY.test(xml)) return { ok: false, reason: "doctype" };
  if (XMLValidator.validate(xml) !== true) {
    return { ok: false, reason: "malformed" };
  }

  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Non-Envelope root (or empty document): no SOAP operation can be found.
  // The design does not specify this case; "no-operation" is used.
  if (!isRecord(doc) || !isRecord(doc["Envelope"])) {
    return { ok: false, reason: "no-operation" };
  }
  const envelope = doc["Envelope"];
  const body = Array.isArray(envelope["Body"]) ? envelope["Body"][0] : envelope["Body"];
  if (!isRecord(body)) return { ok: false, reason: "no-operation" };

  const operation = Object.keys(body).find(isElementKey);
  if (operation === undefined) return { ok: false, reason: "no-operation" };

  const raw = body[operation];
  const opValue = Array.isArray(raw) ? raw[0] : raw;
  const params: Record<string, unknown> = {};
  if (isRecord(opValue)) {
    for (const [k, v] of Object.entries(opValue)) {
      if (!isElementKey(k)) continue;
      // Define via descriptor so keys like "__proto__" stay plain own data.
      Object.defineProperty(params, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return { ok: true, operation, params };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function checkName(name: string): void {
  if (!ELEMENT_NAME.test(name)) {
    throw new Error(`Invalid element name: ${name}`);
  }
}

function renderNode(node: XmlNode, extraAttrs = ""): string {
  checkName(node.name);
  if (node.nil) return `<${node.name}${extraAttrs} xsi:nil="true"/>`;
  const inner =
    node.children !== undefined
      ? node.children.map((c) => renderNode(c)).join("")
      : escapeXml(node.text ?? "");
  return `<${node.name}${extraAttrs}>${inner}</${node.name}>`;
}

function envelope(bodyContent: string): string {
  return (
    `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:xsi="${XSI_NS}">` +
    `<soap:Body>${bodyContent}</soap:Body></soap:Envelope>`
  );
}

export function buildEnvelope(response: XmlNode): string {
  return envelope(renderNode(response, ` xmlns="${BANK_NS}"`));
}

export function buildFault(kind: "Client" | "Server", message: string): string {
  const text = escapeXml(message.slice(0, MAX_FAULT_CHARS));
  return envelope(
    `<soap:Fault><faultcode>soap:${kind}</faultcode>` +
      `<faultstring>${text}</faultstring></soap:Fault>`,
  );
}

/** Returns the id only if it is a string of 1-12 digits, safe to echo. */
export function safeId(v: unknown): string | null {
  return typeof v === "string" && MAX_ECHO_ID.test(v) ? v : null;
}
