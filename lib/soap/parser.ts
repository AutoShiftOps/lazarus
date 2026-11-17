// lib/soap/parser.ts
// WSDL parser pipeline. Stage 1: guardXml. Stage 2: inspectDocument.
// Stage 3: collectSchemaRefs. Stage 4: inlineSchemas.

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { safeFetch } from "./fetcher";
import type { FetchResult } from "./fetcher";
import { heuristicRisk } from "./risk";
import { buildDescriptors } from "./xsd";
import type { DescriptorResult } from "./xsd";
import type {
  BindingStyle,
  LazarusError,
  OperationSchema,
  ServiceDefinition,
  ServicePort,
  SoapVersion,
  Warning,
} from "./types";

const DOCTYPE_PATTERN = /<!\s*DOCTYPE/i;

/**
 * Stage 1: string-level guard run before any XML parser is constructed.
 * Rejects an empty document and any DOCTYPE declaration anywhere in the document (the whole string is scanned).
 * Returns null when the document is acceptable.
 */
export function guardXml(xml: string): LazarusError | null {
  if (xml.trim().length === 0) {
    return {
      code: "WSDL_PARSE_FAILED",
      message: "The WSDL document is empty.",
    };
  }

  if (DOCTYPE_PATTERN.test(xml)) {
    return {
      code: "WSDL_PARSE_FAILED",
      message:
        "The WSDL document contains a DOCTYPE declaration, which is not allowed.",
    };
  }

  return null;
}

export type DocumentInfo = {
  rootNamespace: string;
  rootLocalName: string;
  serviceCount: number;
  targetNamespace: string | null;
};

const WSDL_11_NS = "http://schemas.xmlsoap.org/wsdl/";
const WSDL_20_NS = "http://www.w3.org/ns/wsdl";
const MAX_MESSAGE_LENGTH = 500;
const MAX_DOCUMENTATION = 500;

function parseFailed(message: string): LazarusError {
  return {
    code: "WSDL_PARSE_FAILED",
    message: message.slice(0, MAX_MESSAGE_LENGTH),
  };
}

function splitName(name: string): { prefix: string; local: string } {
  const i = name.indexOf(":");
  return i === -1
    ? { prefix: "", local: name }
    : { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Stage 2: syntax check, root element inspection and service count.
 * Does not call guardXml; callers run Stage 1 first.
 */
export function inspectDocument(xml: string): DocumentInfo | LazarusError {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    return parseFailed(
      `The WSDL document is not well-formed XML (line ${line}, column ${col}): ${msg}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      processEntities: false,
      ignoreDeclaration: true,
      ignoreAttributes: false,
    });
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return parseFailed("The WSDL document could not be parsed.");
  }

  const rootName = Object.keys(parsed).find((k) => !k.startsWith("#") && !k.startsWith("?"));
  if (rootName === undefined) {
    return parseFailed("Not a recognised WSDL document.");
  }

  const rootValue = parsed[rootName];
  const rootNode = asRecord(Array.isArray(rootValue) ? rootValue[0] : rootValue) ?? {};
  const { prefix, local } = splitName(rootName);
  const nsAttr = prefix === "" ? "@_xmlns" : `@_xmlns:${prefix}`;
  const nsValue = rootNode[nsAttr];
  const rootNamespace = typeof nsValue === "string" ? nsValue : "";

  if (rootNamespace === WSDL_20_NS && local === "description") {
    return parseFailed("WSDL 2.0 is not supported yet.");
  }
  if (rootNamespace !== WSDL_11_NS || local !== "definitions") {
    return parseFailed("Not a recognised WSDL document.");
  }

  let serviceCount = 0;
  for (const [key, value] of Object.entries(rootNode)) {
    if (key.startsWith("@_")) continue;
    if (splitName(key).local === "service") {
      serviceCount += Array.isArray(value) ? value.length : 1;
    }
  }
  if (serviceCount === 0) {
    return parseFailed("No services found in the WSDL.");
  }

  const tns = rootNode["@_targetNamespace"];
  return {
    rootNamespace,
    rootLocalName: local,
    serviceCount,
    targetNamespace: typeof tns === "string" ? tns : null,
  };
}

// ─── Stage 3 & 4: schema references and inlining ──────────────────────────────

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
// Matches <import|include|redefine ...> with any prefix. Group 1: qualified name, group 2: attributes.
const REF_TAG_PATTERN =
  /<((?:[^\s<>\/=:"']+:)?(?:import|include|redefine))(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const QUOTED_LOCATION_ATTR =
  /\s+(?:schemaLocation|location)\s*=\s*(?:"[^"]*"|'[^']*')/g;
const ANY_SCHEMA_LOCATION_ATTR =
  /\s+(?:[^\s<>\/=:"']+:)?(?:schemaLocation|noNamespaceSchemaLocation)\s*=\s*(?:"[^"]*"|'[^']*')/g;

const SCHEMA_FETCH_TIMEOUT_MS = 10_000;
const SCHEMA_MAX_BYTES = 2_097_152;
const MAX_SCHEMA_FETCHES = 20;
const MAX_URL_IN_MESSAGE = 120;
const SCHEMA_TOTAL_BUDGET_MS = 25_000;

export type SchemaFetchDeps = {
  fetch: (
    url: string,
    opts: { timeoutMs: number; maxBytes: number },
  ) => Promise<FetchResult>;
};

type RefTag = {
  local: string;
  schemaLocation: string | null;
  location: string | null;
};

function getAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  if (m === null) return null;
  return (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&").trim();
}

function scanRefTags(xml: string): RefTag[] {
  const tags: RefTag[] = [];
  for (const m of xml.replace(COMMENT_PATTERN, "").matchAll(REF_TAG_PATTERN)) {
    tags.push({
      local: splitName(m[1]).local,
      schemaLocation: getAttr(m[2], "schemaLocation"),
      location: getAttr(m[2], "location"),
    });
  }
  return tags;
}

/** Removes every location-bearing attribute so the soap library has nothing to fetch. */
function stripLocations(xml: string): string {
  return xml
    .replace(COMMENT_PATTERN, "")
    .replace(REF_TAG_PATTERN, (_all, name: string, attrs: string) => {
      const cleaned = attrs.replace(QUOTED_LOCATION_ATTR, "");
      return `<${name}${cleaned}>`;
    })
    .replace(ANY_SCHEMA_LOCATION_ATTR, "");
}

/**
 * Stage 3: absolute URLs of every xsd:import / xsd:include that has a
 * schemaLocation, de-duplicated, in document order. A value that cannot be
 * resolved against baseUrl is returned as its raw string.
 */
export function collectSchemaRefs(xml: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const tag of scanRefTags(xml)) {
    if (tag.local !== "import" && tag.local !== "include") continue;
    if (tag.schemaLocation === null || tag.schemaLocation === "") continue;
    let href: string;
    try {
      href = new URL(tag.schemaLocation, baseUrl).href;
    } catch {
      // Unresolvable: keep the raw value so inlineSchemas reports it as SCHEMA_FETCH_FAILED.
      href = tag.schemaLocation;
    }
    if (!seen.has(href)) {
      seen.add(href);
      refs.push(href);
    }
  }
  return refs;
}

function shortUrl(url: string): string {
  return url.length > MAX_URL_IN_MESSAGE ? `${url.slice(0, MAX_URL_IN_MESSAGE)}...` : url;
}

function fetchFailed(url: string): Warning {
  return { code: "SCHEMA_FETCH_FAILED", message: `Could not fetch schema at ${shortUrl(url)}.` };
}

function extractSchemaElement(xml: string): string | null {
  const m = /<((?:[^\s<>\/=:"']+:)?schema)(?=[\s/>])[\s\S]*<\/\1\s*>/.exec(xml.replace(COMMENT_PATTERN, ""));
  return m === null ? null : m[0];
}

function spliceIntoTypes(wsdl: string, schemas: string[]): string {
  if (schemas.length === 0) return wsdl;
  const body = schemas.join("");
  const selfClosing = /<((?:[^\s<>\/=:"']+:)?)types(\s[^>]*)?\s*\/>/;
  const out = wsdl.replace(selfClosing, (_all, prefix: string, attrs: string | undefined) =>
    `<${prefix}types${attrs ?? ""}></${prefix}types>`,
  );
  const close = /<\/((?:[^\s<>\/=:"']+:)?)types\s*>/.exec(out);
  if (close !== null) {
    return out.slice(0, close.index) + body + out.slice(close.index);
  }
  const root = /<((?:[^\s<>\/=:"']+:)?)definitions(?=[\s>])(?:"[^"]*"|'[^']*'|[^>"'])*>/.exec(out);
  if (root === null) return out;
  const at = root.index + root[0].length;
  return `${out.slice(0, at)}<types xmlns="${WSDL_11_NS}">${body}</types>${out.slice(at)}`;
}

/**
 * Stage 4: fetch referenced schemas (following their own imports), splice them
 * into the WSDL's <types>, and strip every location attribute from the result.
 * All network access goes through deps.fetch.
 */
export async function inlineSchemas(
  xml: string,
  refs: string[],
  baseUrl: string,
  deps: SchemaFetchDeps = { fetch: safeFetch },
): Promise<{ xml: string; warnings: Warning[] }> {
  void baseUrl; // refs are already absolute; nested refs resolve against their own schema URL.
  const warnings: Warning[] = [];
  if (scanRefTags(xml).some((t) => t.schemaLocation === null && t.location !== null)) {
    warnings.push({
      code: "WSDL_IMPORT_NOT_SUPPORTED",
      message: "wsdl:import is not supported; the imported document was ignored.",
    });
  }

  const queue: string[] = [...refs];
  const visited = new Set<string>();
  const schemas: string[] = [];
  let fetches = 0;
  let limitWarned = false;
  const deadline = Date.now() + SCHEMA_TOTAL_BUDGET_MS;

  while (queue.length > 0) {
    const ref = queue.shift() as string;
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      if (!visited.has(ref)) {
        visited.add(ref);
        warnings.push(fetchFailed(ref));
      }
      continue;
    }
    const href = url.href;
    if (visited.has(href)) continue;
    visited.add(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      warnings.push(fetchFailed(href));
      continue;
    }
    if (fetches >= MAX_SCHEMA_FETCHES) {
      if (!limitWarned) {
        limitWarned = true;
        warnings.push({
          code: "SCHEMA_LIMIT_REACHED",
          message: `Schema import limit reached; only ${MAX_SCHEMA_FETCHES} schemas were fetched.`,
        });
      }
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      warnings.push({
        code: "SCHEMA_TIME_BUDGET_EXCEEDED",
        message: "Schema fetching stopped: the time limit was reached.",
      });
      break;
    }
    fetches += 1;

    let result: FetchResult;
    try {
      result = await deps.fetch(href, {
        timeoutMs: Math.min(SCHEMA_FETCH_TIMEOUT_MS, remaining),
        maxBytes: SCHEMA_MAX_BYTES,
      });
    } catch {
      warnings.push(fetchFailed(href));
      continue;
    }
    if (!result.ok) {
      warnings.push(
        result.error.code === "WSDL_TOO_LARGE"
          ? { code: "SCHEMA_TOO_LARGE", message: `Schema at ${shortUrl(href)} is too large.` }
          : fetchFailed(href),
      );
      continue;
    }
    if (guardXml(result.xml) !== null) {
      warnings.push(fetchFailed(href));
      continue;
    }
    const schema = extractSchemaElement(result.xml);
    if (schema === null) {
      warnings.push(fetchFailed(href));
      continue;
    }
    schemas.push(stripLocations(schema));
    queue.push(...collectSchemaRefs(schema, href));
  }

  return { xml: spliceIntoTypes(stripLocations(xml), schemas), warnings };
}

// ─── Stage 5 part 1: tree verifier and indexes ────────────────────────────────

const SOAP_11_BINDING_NS = "http://schemas.xmlsoap.org/wsdl/soap/";
const SOAP_12_BINDING_NS = "http://schemas.xmlsoap.org/wsdl/soap12/";
const LOCATION_ELEMENTS = new Set(["import", "include", "redefine"]);

function parseTree(xml: string): Record<string, unknown> | null {
  try {
    const parser = new XMLParser({
      processEntities: false,
      ignoreDeclaration: true,
      ignoreAttributes: false,
    });
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isElementKey(key: string): boolean {
  return !key.startsWith("@_") && !key.startsWith("#") && !key.startsWith("?");
}

/** fast-xml-parser returns one child as an object and many as an array; normalise to a list of nodes. */
function childNodes(node: Record<string, unknown>, local: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key) || splitName(key).local !== local) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      out.push(asRecord(item) ?? {});
    }
  }
  return out;
}

function attrOf(node: Record<string, unknown>, name: string): string | null {
  const v = node[`@_${name}`];
  return typeof v === "string" ? v : null;
}

function localAttr(node: Record<string, unknown>, name: string): string | null {
  const v = attrOf(node, name);
  return v === null ? null : splitName(v).local;
}

function treeHasLocation(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(treeHasLocation);
  const rec = asRecord(node);
  if (rec === null) return false;
  for (const [key, value] of Object.entries(rec)) {
    if (!isElementKey(key)) continue;
    if (LOCATION_ELEMENTS.has(splitName(key).local)) {
      const items = Array.isArray(value) ? value : [value];
      const dirty = items.some((i) => {
        const r = asRecord(i);
        return r !== null && ("@_schemaLocation" in r || "@_location" in r);
      });
      if (dirty) return true;
    }
    if (treeHasLocation(value)) return true;
  }
  return false;
}

/**
 * Stage 5 verifier: fails closed when any import/include/redefine element (any prefix)
 * still carries schemaLocation or location. Returns null when the tree is clean.
 */
export function verifyNoLocations(xml: string): LazarusError | null {
  const tree = parseTree(xml);
  if (tree === null) return parseFailed("The WSDL document could not be parsed.");
  if (treeHasLocation(tree)) {
    return parseFailed(
      "The WSDL document still references an external location after schema inlining.",
    );
  }
  return null;
}

export type MessagePart = { name: string; element: string | null; type: string | null };
export type PortTypeOperation = {
  name: string;
  input: string | null;
  output: string | null;
  documentation?: string;
};
export type BindingOperation = {
  name: string;
  documentation?: string;
  soapAction: string | null;
  style: string | null;
  inputUse: string | null;
  outputUse: string | null;
};
export type BindingIndex = {
  name: string;
  portType: string | null;
  soapVersion: SoapVersion | null;
  transport: string | null;
  style: string | null;
  operations: BindingOperation[];
};
export type PortIndex = { name: string; binding: string | null; address: string | null };
export type WsdlIndex = {
  messages: Record<string, { name: string; parts: MessagePart[] }>;
  portTypes: Record<string, { name: string; operations: PortTypeOperation[] }>;
  bindings: Record<string, BindingIndex>;
  services: Record<string, { name: string; ports: PortIndex[] }>;
};

function nsDeclarations(node: Record<string, unknown>, into: Map<string, string>): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") continue;
    if (key === "@_xmlns") into.set("", value);
    else if (key.startsWith("@_xmlns:")) into.set(key.slice(8), value);
  }
}

/** First child element with the given local name, with its qualified key (needed for namespace lookup). */
function firstChild(
  node: Record<string, unknown>,
  local: string,
): { key: string; node: Record<string, unknown> } | null {
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key) || splitName(key).local !== local) continue;
    return { key, node: asRecord(Array.isArray(value) ? value[0] : value) ?? {} };
  }
  return null;
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collectText(v, out);
  else {
    const rec = asRecord(value);
    if (rec === null) return;
    for (const [k, v] of Object.entries(rec)) {
      if (!k.startsWith("@_") && !k.startsWith("?")) collectText(v, out);
    }
  }
}

/** Text of the first child element named "documentation" (any prefix): tags stripped, whitespace collapsed, <= 500 chars. */
function documentationOf(node: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key) || splitName(key).local !== "documentation") continue;
    const parts: string[] = [];
    collectText(Array.isArray(value) ? value[0] : value, parts);
    const text = parts
      .join(" ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_DOCUMENTATION);
    return text === "" ? undefined : text;
  }
  return undefined;
}

function bodyUse(op: Record<string, unknown>, direction: "input" | "output"): string | null {
  const io = childNodes(op, direction)[0];
  const body = io === undefined ? undefined : childNodes(io, "body")[0];
  return body === undefined ? null : attrOf(body, "use");
}

function indexBinding(b: Record<string, unknown>, name: string, root: Map<string, string>): BindingIndex {
  const scope = new Map(root);
  nsDeclarations(b, scope);
  const sb = firstChild(b, "binding");
  let soapVersion: SoapVersion | null = null;
  if (sb !== null) {
    const inner = new Map(scope);
    nsDeclarations(sb.node, inner);
    const ns = inner.get(splitName(sb.key).prefix);
    if (ns === SOAP_12_BINDING_NS) soapVersion = "1.2";
    else if (ns === SOAP_11_BINDING_NS) soapVersion = "1.1";
  }
  const operations: BindingOperation[] = [];
  for (const op of childNodes(b, "operation")) {
    const opName = attrOf(op, "name");
    if (opName === null) continue;
    const so = firstChild(op, "operation");
    operations.push({
      name: opName,
      documentation: documentationOf(op),
      soapAction: so === null ? null : attrOf(so.node, "soapAction"),
      style: so === null ? null : attrOf(so.node, "style"),
      inputUse: bodyUse(op, "input"),
      outputUse: bodyUse(op, "output"),
    });
  }
  return {
    name,
    portType: localAttr(b, "type"),
    soapVersion,
    transport: sb === null ? null : attrOf(sb.node, "transport"),
    style: sb === null ? null : attrOf(sb.node, "style"),
    operations,
  };
}

/**
 * Stage 5 index builder: messages, portTypes, bindings and services/ports keyed by local name.
 * Returns WSDL_PARSE_FAILED if the document cannot be parsed or is not a definitions root.
 */
export function indexDocument(xml: string): WsdlIndex | LazarusError {
  const tree = parseTree(xml);
  if (tree === null) return parseFailed("The WSDL document could not be parsed.");
  const rootKey = Object.keys(tree).find(isElementKey);
  const rootValue = rootKey === undefined ? undefined : tree[rootKey];
  const root = asRecord(Array.isArray(rootValue) ? rootValue[0] : rootValue);
  if (rootKey === undefined || root === null || splitName(rootKey).local !== "definitions") {
    return parseFailed("Not a recognised WSDL document.");
  }
  const scope = new Map<string, string>();
  nsDeclarations(root, scope);

  const index: WsdlIndex = { messages: {}, portTypes: {}, bindings: {}, services: {} };

  for (const m of childNodes(root, "message")) {
    const name = attrOf(m, "name");
    if (name === null) continue;
    index.messages[name] = {
      name,
      parts: childNodes(m, "part").map((p) => ({
        name: attrOf(p, "name") ?? "",
        element: localAttr(p, "element"),
        type: localAttr(p, "type"),
      })),
    };
  }

  for (const pt of childNodes(root, "portType")) {
    const name = attrOf(pt, "name");
    if (name === null) continue;
    const operations: PortTypeOperation[] = [];
    for (const op of childNodes(pt, "operation")) {
      const opName = attrOf(op, "name");
      if (opName === null) continue;
      operations.push({
        name: opName,
        documentation: documentationOf(op),
        input: localAttr(childNodes(op, "input")[0] ?? {}, "message"),
        output: localAttr(childNodes(op, "output")[0] ?? {}, "message"),
      });
    }
    index.portTypes[name] = { name, operations };
  }

  for (const b of childNodes(root, "binding")) {
    const name = attrOf(b, "name");
    if (name !== null) index.bindings[name] = indexBinding(b, name, scope);
  }

  for (const s of childNodes(root, "service")) {
    const name = attrOf(s, "name");
    if (name === null) continue;
    index.services[name] = {
      name,
      ports: childNodes(s, "port").map((p) => {
        const addr = firstChild(p, "address");
        return {
          name: attrOf(p, "name") ?? "",
          binding: localAttr(p, "binding"),
          address: addr === null ? null : attrOf(addr.node, "location"),
        };
      }),
    };
  }

  return index;
}

// ─── Stage 5 part 2: operations and definition ────────────────────────────────

const ACCEPTED_TRANSPORTS = new Set([
  "http://schemas.xmlsoap.org/soap/http",
  "http://www.w3.org/2003/05/soap/bindings/HTTP/",
]);

function classifyStyle(style: string | null, use: string | null): BindingStyle {
  // WSDL 1.1 says a missing style means "document".
  const s = style ?? "document";
  if (s === "document" && use === "literal") return "document/literal";
  if (s === "rpc" && use === "literal") return "rpc/literal";
  if (s === "document" && use === "encoded") return "document/encoded";
  if (s === "rpc" && use === "encoded") return "rpc/encoded";
  return "unknown";
}

function schemaElementFormDefault(
  root: Record<string, unknown>,
  targetNamespace: string | null,
): "qualified" | "unqualified" {
  const schemas = childNodes(root, "types").flatMap((t) => childNodes(t, "schema"));
  const match =
    schemas.find((s) => attrOf(s, "targetNamespace") === targetNamespace) ?? schemas[0];
  return match !== undefined && attrOf(match, "elementFormDefault") === "qualified"
    ? "qualified"
    : "unqualified";
}

type Candidate = {
  version: SoapVersion;
  binding: BindingIndex;
  portName: string;
  address: string;
};

/**
 * Stage 5: build the ServiceDefinition from the assembled, location-free document.
 * Input and output descriptors are filled by buildDescriptors (lib/soap/xsd.ts).
 */
export function buildDefinition(
  xml: string,
  info: DocumentInfo,
): ServiceDefinition | LazarusError {
  const index = indexDocument(xml);
  if ("code" in index) return index;
  const tree = parseTree(xml);
  const rootKey = tree === null ? undefined : Object.keys(tree).find(isElementKey);
  const rootValue = tree === null || rootKey === undefined ? undefined : tree[rootKey];
  const root = asRecord(Array.isArray(rootValue) ? rootValue[0] : rootValue) ?? {};

  const serviceNames = Object.keys(index.services);
  if (serviceNames.length === 0) return parseFailed("No services found in the WSDL.");

  const warnings: Warning[] = [];
  const accepted = new Set<string>();
  for (const b of Object.values(index.bindings)) {
    if (b.soapVersion !== null && b.transport !== null && ACCEPTED_TRANSPORTS.has(b.transport)) {
      accepted.add(b.name);
    } else {
      warnings.push({
        code: "UNSUPPORTED_BINDING",
        message: `Binding ${b.name} uses an unsupported transport and was skipped.`,
      });
    }
  }

  // portType -> operation -> candidates (SOAP 1.1 first)
  const groups = new Map<string, Map<string, Candidate[]>>();
  for (const service of Object.values(index.services)) {
    for (const port of service.ports) {
      const binding = port.binding === null ? undefined : index.bindings[port.binding];
      if (binding === undefined || !accepted.has(binding.name) || binding.portType === null) continue;
      const portType = index.portTypes[binding.portType];
      if (portType === undefined || binding.soapVersion === null) continue;
      const byOp = groups.get(portType.name) ?? new Map<string, Candidate[]>();
      groups.set(portType.name, byOp);
      for (const bop of binding.operations) {
        const list = byOp.get(bop.name) ?? [];
        byOp.set(bop.name, list);
        list.push({
          version: binding.soapVersion,
          binding,
          portName: port.name,
          address: port.address ?? "",
        });
      }
    }
  }

  const targetNamespace = info.targetNamespace ?? "";
  const elementFormDefault = schemaElementFormDefault(root, info.targetNamespace);
  const ports: ServicePort[] = [];

  for (const [portTypeName, byOp] of groups) {
    const portType = index.portTypes[portTypeName];
    const operations: OperationSchema[] = [];
    let portName = "";
    let portAddress = "";

    for (const [opName, rawCandidates] of byOp) {
      const candidates = [...rawCandidates].sort((a, b) => (a.version === b.version ? 0 : a.version === "1.1" ? -1 : 1));
      const preferred = candidates[0];
      const ptOp = portType.operations.find((o) => o.name === opName);
      if (ptOp === undefined) continue;
      if (portName === "") {
        portName = preferred.portName;
        portAddress = preferred.address;
      }
      const hasBoth = candidates.some((c) => c.version === "1.1") && candidates.some((c) => c.version === "1.2");
      const bop = preferred.binding.operations.find((o) => o.name === opName);
      if (bop === undefined) continue;
      const style = bop.style ?? preferred.binding.style;
      const bindingStyle = classifyStyle(style, bop.inputUse ?? bop.outputUse);
      const isRpc = (style ?? "document") === "rpc";
      const opWarnings: Warning[] = [];
      if (bindingStyle === "rpc/encoded") {
        opWarnings.push({
          code: "RPC_ENCODED",
          message: `Operation ${opName} uses rpc/encoded, which is not supported for live calls.`,
        });
      }
      const messageParts = (msg: string | null): MessagePart[] =>
        msg === null ? [] : (index.messages[msg]?.parts ?? []);
      const messageElement = (msg: string | null): string | null =>
        messageParts(msg)[0]?.element ?? null;
      const describe = (msg: string | null, elementName: string): DescriptorResult =>
        msg === null
          ? { fields: [], warnings: [] }
          : buildDescriptors(root, isRpc ? null : elementName, {
              style: isRpc ? "rpc" : "document",
              parts: messageParts(msg),
            });
      const inputElementName = isRpc ? opName : (messageElement(ptOp.input) ?? opName);
      const outputElementName =
        ptOp.output === null
          ? ""
          : isRpc
            ? `${opName}Response`
            : (messageElement(ptOp.output) ?? `${opName}Response`);
      const inputDesc = describe(ptOp.input, inputElementName);
      const outputDesc = describe(ptOp.output, outputElementName);
      opWarnings.push(...inputDesc.warnings, ...outputDesc.warnings);
      const documentation = ptOp.documentation ?? bop.documentation;
      const heuristic = heuristicRisk(opName, documentation);
      operations.push({
        name: opName,
        risk: heuristic.risk,
        riskReason: heuristic.reason,
        riskSource: "heuristic",
        ...(documentation === undefined ? {} : { documentation }),
        soapVersions: hasBoth ? ["1.1", "1.2"] : [preferred.version],
        preferredVersion: preferred.version,
        bindingStyle,
        soapAction: bop.soapAction ?? "",
        targetNamespace,
        inputElementName,
        outputElementName,
        endpointAddress: preferred.address,
        elementFormDefault,
        inputDescriptor: inputDesc.fields,
        outputDescriptor: outputDesc.fields,
        warnings: opWarnings,
      });
    }
    if (operations.length > 0) {
      ports.push({ name: portName, address: portAddress, operations });
    }
  }

  if (ports.length === 0) {
    return parseFailed("No operations with a supported SOAP binding were found in the WSDL.");
  }

  return { name: serviceNames[0], wsdlUrl: "", ports, warnings };
}

// ─── parseWsdl: Stages 1-5 ────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; definition: ServiceDefinition }
  | { ok: false; error: LazarusError };

export type ParseDeps = {
  fetch?: SchemaFetchDeps["fetch"];
  /** URL the WSDL was fetched from; used to resolve relative schemaLocations. */
  baseUrl?: string;
};

export async function parseWsdl(xml: string, deps: ParseDeps = {}): Promise<ParseResult> {
  const guarded = guardXml(xml);
  if (guarded !== null) return { ok: false, error: guarded };

  const info = inspectDocument(xml);
  if ("code" in info) return { ok: false, error: info };

  const baseUrl = deps.baseUrl ?? "";
  const refs = collectSchemaRefs(xml, baseUrl);
  const inlined = await inlineSchemas(xml, refs, baseUrl, { fetch: deps.fetch ?? safeFetch });

  const leftover = verifyNoLocations(inlined.xml);
  if (leftover !== null) return { ok: false, error: leftover };

  const definition = buildDefinition(inlined.xml, info);
  if ("code" in definition) return { ok: false, error: definition };

  return {
    ok: true,
    definition: {
      ...definition,
      wsdlUrl: baseUrl,
      warnings: [...inlined.warnings, ...definition.warnings],
    },
  };
}
