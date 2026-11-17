// lib/soap/translator.ts
// JSON -> SOAP envelope translation (Requirement 5). Pure, no I/O.

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { guardXml } from "./parser";
import { INTEGER_TYPES, NUMBER_TYPES, buildZodSchema } from "./schema-generator";
import type {
  EnvelopeResult,
  FaultError,
  FieldDescriptor,
  OperationSchema,
  ParseEnvelopeResult,
  SoapVersion,
  ValidationError,
} from "./types";

const SOAP_11_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const SOAP_12_NS = "http://www.w3.org/2003/05/soap-envelope";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

const ELEMENT_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Characters illegal in XML 1.0 documents.
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

export function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(message: string): string {
  return message.slice(0, 200);
}

/** Internal control-flow error; never escapes toEnvelope. */
class TranslationFailure extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

type NamespaceMode = "all" | "top" | "none";

type BuildContext = {
  usesNil: boolean;
};

function validationError(
  issues: { path: string; message: string }[],
  missingFields: string[] = [],
): EnvelopeResult {
  return {
    ok: false,
    error: {
      type: "validationError",
      missingFields,
      issues: issues.map((i) => ({ path: i.path, message: truncate(i.message) })),
    } satisfies ValidationError,
  };
}

function checkDescriptorNames(fields: FieldDescriptor[], parent: string): void {
  for (const field of fields) {
    const path = parent === "" ? field.name : `${parent}.${field.name}`;
    if (!ELEMENT_NAME_REGEX.test(field.name)) {
      throw new TranslationFailure(
        path,
        "Element name from the service description is not a valid XML name.",
      );
    }
    if (field.children) checkDescriptorNames(field.children, path);
  }
}

function leafText(value: unknown, path: string): string {
  if (typeof value === "string") {
    if (ILLEGAL_XML_CHARS.test(value)) {
      throw new TranslationFailure(
        path,
        "Value contains a character that is not allowed in XML 1.0.",
      );
    }
    return xmlEscape(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TranslationFailure(path, "Number must be finite.");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new TranslationFailure(path, "Value cannot be written as XML text.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildElement(
  field: FieldDescriptor,
  value: unknown,
  path: string,
  mode: NamespaceMode,
  ctx: BuildContext,
): string {
  const attr = mode === "none" ? "" : ' xmlns=""';
  const childMode: NamespaceMode = mode === "all" ? "all" : "none";

  if (value === null) {
    ctx.usesNil = true;
    return `<${field.name}${attr} xsi:nil="true"/>`;
  }

  if (Array.isArray(value)) {
    return value
      .map((item, i) =>
        buildSingle(field, item, `${path}.${i}`, attr, childMode, ctx),
      )
      .join("");
  }
  return buildSingle(field, value, path, attr, childMode, ctx);
}

function buildSingle(
  field: FieldDescriptor,
  value: unknown,
  path: string,
  attr: string,
  childMode: NamespaceMode,
  ctx: BuildContext,
): string {
  if (field.children) {
    if (!isRecord(value)) {
      throw new TranslationFailure(path, "Expected an object.");
    }
    const inner = buildFields(field.children, value, path, childMode, ctx);
    return `<${field.name}${attr}>${inner}</${field.name}>`;
  }
  return `<${field.name}${attr}>${leafText(value, path)}</${field.name}>`;
}

function buildFields(
  fields: FieldDescriptor[],
  data: Record<string, unknown>,
  parent: string,
  mode: NamespaceMode,
  ctx: BuildContext,
): string {
  let out = "";
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined) continue;
    const path = parent === "" ? field.name : `${parent}.${field.name}`;
    out += buildElement(field, value, path, mode, ctx);
  }
  return out;
}

function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function actionForHeader(action: string): string {
  return action.replace(/[\r\n"]/g, "");
}

export function toEnvelope(args: unknown, schema: OperationSchema): EnvelopeResult {
  if (schema.bindingStyle === "rpc/encoded" || schema.bindingStyle === "document/encoded") {
    return {
      ok: false,
      error: {
        type: "unsupported",
        message: `${schema.bindingStyle} is not supported for live calls.`,
      },
    };
  }

  const ctx: BuildContext = { usesNil: false };
  let body: string;
  try {
    checkDescriptorNames(schema.inputDescriptor, "");
    if (!ELEMENT_NAME_REGEX.test(schema.inputElementName)) {
      throw new TranslationFailure(
        schema.inputElementName,
        "Element name from the service description is not a valid XML name.",
      );
    }
    if (schema.bindingStyle === "rpc/literal" && !ELEMENT_NAME_REGEX.test(schema.name)) {
      throw new TranslationFailure(
        schema.name,
        "Operation name from the service description is not a valid XML name.",
      );
    }

    const parsed = buildZodSchema(schema.inputDescriptor).safeParse(args);
    if (!parsed.success) {
      const missing: string[] = [];
      const issues = parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        if (valueAtPath(args, issue.path) === undefined && !missing.includes(path)) {
          missing.push(path);
        }
        return { path, message: issue.message };
      });
      return validationError(issues, missing);
    }

    const data = parsed.data as Record<string, unknown>;
    const isRpc = schema.bindingStyle === "rpc/literal";
    const wrapperName = isRpc ? schema.name : schema.inputElementName;
    const mode: NamespaceMode = isRpc
      ? "top"
      : schema.elementFormDefault === "unqualified"
        ? "all"
        : "none";
    const inner = buildFields(schema.inputDescriptor, data, "", mode, ctx);
    const ns = xmlEscape(schema.targetNamespace);
    body = `<${wrapperName} xmlns="${ns}">${inner}</${wrapperName}>`;
  } catch (e) {
    if (e instanceof TranslationFailure) {
      return validationError([{ path: e.path, message: e.detail }]);
    }
    throw e;
  }

  const is12 = schema.preferredVersion === "1.2";
  const soapNs = is12 ? SOAP_12_NS : SOAP_11_NS;
  const xsiDecl = ctx.usesNil ? ` xmlns:xsi="${XSI_NS}"` : "";
  const xml =
    `<soap:Envelope xmlns:soap="${soapNs}"${xsiDecl}>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;

  const action = actionForHeader(schema.soapAction);
  const headers: Record<string, string> = is12
    ? { "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"` }
    : { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` };

  return { ok: true, xml, headers };
}

// ─── SOAP response -> JSON (Requirements 5.4, 5.5, 5.6) ───────────────────────

const MAX_WARNINGS = 10;
const MAX_DETAIL_LENGTH = 1000;
const UNKNOWN = "unknown";

type XmlNode = Record<string, unknown>;

function parseFailure(message: string): ParseEnvelopeResult {
  return { ok: false, error: { type: "parseError", message: truncate(message) } };
}

function localName(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

function isElementKey(key: string): boolean {
  return !key.startsWith("@_") && !key.startsWith("#") && !key.startsWith("?");
}

/** All child elements with the given local name, flattening fast-xml-parser's object-or-array shape. */
function childrenByLocalName(node: XmlNode, local: string): unknown[] {
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key) || localName(key) !== local) continue;
    if (Array.isArray(value)) out.push(...(value as unknown[]));
    else out.push(value);
  }
  return out;
}

function asNode(value: unknown): XmlNode {
  return isRecord(value) ? value : {};
}

/** Own text of an element: a plain string, or the #text of an element that has attributes. */
function ownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const t = value["#text"];
    return typeof t === "string" ? t : "";
  }
  return "";
}

/** Concatenated text of a whole subtree, joined with single spaces. */
function flattenText(value: unknown, parts: string[] = []): string[] {
  if (typeof value === "string") {
    parts.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value as unknown[]) flattenText(item, parts);
  } else if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith("@_") || key.startsWith("?")) continue;
      flattenText(v, parts);
    }
  }
  return parts;
}

function textOrUnknown(values: unknown[]): string {
  const first = values[0];
  const text = ownText(first);
  return text === "" ? UNKNOWN : text;
}

export function normaliseFault(faultNode: unknown, version: SoapVersion): FaultError {
  const node = asNode(faultNode);
  let faultCode: string;
  let faultString: string;
  let detailNodes: unknown[];

  if (version === "1.2") {
    const code = asNode(childrenByLocalName(node, "Code")[0]);
    faultCode = textOrUnknown(childrenByLocalName(code, "Value"));
    const reason = asNode(childrenByLocalName(node, "Reason")[0]);
    faultString = textOrUnknown(childrenByLocalName(reason, "Text"));
    detailNodes = childrenByLocalName(node, "Detail");
  } else {
    faultCode = textOrUnknown(childrenByLocalName(node, "faultcode"));
    faultString = textOrUnknown(childrenByLocalName(node, "faultstring"));
    detailNodes = childrenByLocalName(node, "detail");
  }

  const fault: FaultError = { type: "fault", faultCode, faultString };
  const detail = flattenText(detailNodes).join(" ").trim().slice(0, MAX_DETAIL_LENGTH);
  if (detail !== "") fault.detail = detail;
  return fault;
}

class Warnings {
  readonly items: string[] = [];
  add(message: string): void {
    if (this.items.length < MAX_WARNINGS) this.items.push(truncate(message));
  }
}

function isNil(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (!key.startsWith("@_") || localName(key.slice(2)) !== "nil") continue;
    if (v === "true" || v === "1") return true;
  }
  return false;
}

const INTEGER_PATTERN = /^[+-]?\d+$/;
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Returns undefined when the text cannot be converted (a warning has been added). */
function convertLeaf(field: FieldDescriptor, text: string, warnings: Warnings): unknown {
  const type = field.xsdType;
  if (INTEGER_TYPES.has(type) || NUMBER_TYPES.has(type)) {
    const t = text.trim();
    const pattern = INTEGER_TYPES.has(type) ? INTEGER_PATTERN : NUMBER_PATTERN;
    const n = pattern.test(t) ? Number(t) : Number.NaN;
    if (!Number.isFinite(n)) {
      warnings.add(`Element ${field.name} is not a valid ${type}`);
      return undefined;
    }
    return n;
  }
  if (type === "boolean") {
    const t = text.trim();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
    warnings.add(`Element ${field.name} is not a valid boolean`);
    return undefined;
  }
  return text;
}

function convertItem(field: FieldDescriptor, value: unknown, warnings: Warnings): unknown {
  if (isNil(value)) return null;
  if (field.children) {
    return walkFields(field.children, asNode(value), warnings);
  }
  return convertLeaf(field, ownText(value), warnings);
}

function walkFields(
  fields: FieldDescriptor[],
  node: XmlNode,
  warnings: Warnings,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === "__proto__") continue;
    const matches = childrenByLocalName(node, field.name);
    if (matches.length === 0) {
      if (field.minOccurs > 0) warnings.add(`Missing required element ${field.name}`);
      continue;
    }
    const isList = field.maxOccurs === "unbounded" || field.maxOccurs > 1;
    if (isList) {
      const items: unknown[] = [];
      for (const m of matches) {
        const item = convertItem(field, m, warnings);
        if (item !== undefined) items.push(item);
      }
      out[field.name] = items;
    } else {
      const item = convertItem(field, matches[0], warnings);
      if (item !== undefined) out[field.name] = item;
    }
  }
  return out;
}

function parseXml(xml: string): XmlNode | null {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      // Safe only because guardXml has already rejected every DOCTYPE.
      processEntities: true,
      // Required for numeric references (&#65;); also decodes common HTML names.
      htmlEntities: true,
    });
    return asNode(parser.parse(xml));
  } catch {
    return null;
  }
}

function envelopeVersion(envelopeKey: string, envelope: XmlNode): SoapVersion | null {
  const colon = envelopeKey.indexOf(":");
  const attr = colon === -1 ? "@_xmlns" : `@_xmlns:${envelopeKey.slice(0, colon)}`;
  const ns = envelope[attr];
  if (ns === SOAP_11_NS) return "1.1";
  if (ns === SOAP_12_NS) return "1.2";
  return null;
}

export function fromEnvelope(xml: string, schema: OperationSchema): ParseEnvelopeResult {
  const guard = guardXml(xml);
  if (guard !== null) {
    return parseFailure(
      xml.trim().length === 0
        ? "The response is empty."
        : "The response contains a DOCTYPE declaration, which is not allowed.",
    );
  }
  if (XMLValidator.validate(xml) !== true) {
    return parseFailure("The response is not well-formed XML.");
  }
  const tree = parseXml(xml);
  if (tree === null) return parseFailure("The response could not be parsed as XML.");

  const rootKey = Object.keys(tree).find(isElementKey);
  if (rootKey === undefined || localName(rootKey) !== "Envelope") {
    return parseFailure("The response is not a SOAP envelope.");
  }
  const envelope = asNode(Array.isArray(tree[rootKey]) ? (tree[rootKey] as unknown[])[0] : tree[rootKey]);
  const version = envelopeVersion(rootKey, envelope);
  if (version === null) {
    return parseFailure("The response envelope has an unknown SOAP namespace.");
  }

  const bodies = childrenByLocalName(envelope, "Body");
  if (bodies.length === 0) return parseFailure("The SOAP envelope has no Body.");
  const body = asNode(bodies[0]);

  const faults = childrenByLocalName(body, "Fault");
  if (faults.length > 0) return { ok: false, error: normaliseFault(faults[0], version) };

  const wrapperKey = Object.keys(body).find(isElementKey);
  if (wrapperKey === undefined) {
    return parseFailure("The SOAP Body has no response element.");
  }
  const wrapperValue = body[wrapperKey];
  const wrapper = asNode(Array.isArray(wrapperValue) ? (wrapperValue as unknown[])[0] : wrapperValue);

  const warnings = new Warnings();
  const data = walkFields(schema.outputDescriptor, wrapper, warnings);
  return { ok: true, data, warnings: warnings.items };
}
