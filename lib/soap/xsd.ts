// lib/soap/xsd.ts
// Pure functions that turn the already-parsed WSDL tree into FieldDescriptor[].
// No I/O. Attributes are ignored. Because fast-xml-parser groups children by tag name,
// document order is preserved among siblings of the same tag (the normal case for
// xsd:sequence of xsd:element); different group kinds are emitted sequence, all, choice.

import type { FieldDescriptor, Warning } from "./types";

type Node = Record<string, unknown>;

export type PartInfo = { name: string; element: string | null; type: string | null };

export type DescriptorContext = {
  style: "document" | "rpc";
  /** Message parts of the operation direction being described (used for rpc style). */
  parts: PartInfo[];
};

export type DescriptorResult = { fields: FieldDescriptor[]; warnings: Warning[] };

const XSD_NS = "http://www.w3.org/2001/XMLSchema";
const MAX_DEPTH = 8;
const MAX_MESSAGE = 200;

const BUILTINS = new Set([
  "string", "normalizedString", "token", "boolean", "decimal", "float", "double",
  "integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger",
  "nonPositiveInteger", "negativeInteger", "unsignedInt", "unsignedLong",
  "unsignedShort", "unsignedByte", "duration", "dateTime", "time", "date",
  "gYearMonth", "gYear", "gMonthDay", "gDay", "gMonth", "hexBinary", "base64Binary",
  "anyURI", "QName", "NOTATION", "anyType", "anySimpleType", "language", "Name",
  "NCName", "ID", "IDREF", "NMTOKEN", "char", "guid",
]);

function localOf(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

function prefixOf(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? "" : name.slice(0, i);
}

function asNode(value: unknown): Node | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Node)
    : null;
}

function children(node: Node, local: string): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key.startsWith("#") || key.startsWith("?")) continue;
    if (localOf(key) !== local) continue;
    for (const item of Array.isArray(value) ? value : [value]) out.push(asNode(item) ?? {});
  }
  return out;
}

function attr(node: Node, name: string): string | null {
  const v = node[`@_${name}`];
  return typeof v === "string" ? v : null;
}

type Index = {
  elements: Map<string, Node>;
  complexTypes: Map<string, Node>;
  simpleTypes: Map<string, Node>;
  ns: Map<string, string>;
  warnings: Warning[];
  seen: Set<string>;
};

function collectNs(node: Node, into: Map<string, string>): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") continue;
    if (key === "@_xmlns") into.set("", value);
    else if (key.startsWith("@_xmlns:")) into.set(key.slice(8), value);
  }
}

function buildIndex(root: Node): Index {
  const ix: Index = {
    elements: new Map(),
    complexTypes: new Map(),
    simpleTypes: new Map(),
    ns: new Map(),
    warnings: [],
    seen: new Set(),
  };
  collectNs(root, ix.ns);
  const schemas = children(root, "types").flatMap((t) => children(t, "schema"));
  for (const schema of schemas) {
    collectNs(schema, ix.ns);
    const put = (map: Map<string, Node>, nodes: Node[]): void => {
      for (const n of nodes) {
        const name = attr(n, "name");
        if (name !== null && !map.has(name)) map.set(name, n);
      }
    };
    put(ix.elements, children(schema, "element"));
    put(ix.complexTypes, children(schema, "complexType"));
    put(ix.simpleTypes, children(schema, "simpleType"));
  }
  return ix;
}

function warn(ix: Index, code: string, message: string): void {
  const text = message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE) : message;
  const key = `${code}|${text}`;
  if (ix.seen.has(key)) return;
  ix.seen.add(key);
  ix.warnings.push({ code, message: text });
}

function isXsd(ix: Index, qname: string): boolean {
  return ix.ns.get(prefixOf(qname)) === XSD_NS;
}

function simpleBase(ix: Index, st: Node, guard = 0): string {
  const restriction = children(st, "restriction")[0];
  if (restriction === undefined) return "string";
  const base = attr(restriction, "base");
  if (base !== null) {
    if (isXsd(ix, base)) return localOf(base);
    const next = ix.simpleTypes.get(localOf(base));
    if (next !== undefined && guard < 10) return simpleBase(ix, next, guard + 1);
    return localOf(base);
  }
  const inner = children(restriction, "simpleType")[0];
  return inner !== undefined && guard < 10 ? simpleBase(ix, inner, guard + 1) : "string";
}

function occursOf(node: Node): { min: number; max: number | "unbounded" } {
  const minRaw = attr(node, "minOccurs");
  const maxRaw = attr(node, "maxOccurs");
  const min = minRaw === null || !/^\d+$/.test(minRaw) ? 1 : Number(minRaw);
  const max = maxRaw === "unbounded" ? "unbounded" : maxRaw !== null && /^\d+$/.test(maxRaw) ? Number(maxRaw) : 1;
  return { min, max };
}

function expandInto(
  ix: Index,
  field: FieldDescriptor,
  ct: Node,
  key: string | null,
  path: string[],
  depth: number,
): void {
  if (key !== null && path.includes(key)) {
    warn(ix, "XSD_CYCLE", `Type ${field.xsdType} refers to itself; it was not expanded again.`);
    return;
  }
  if (depth >= MAX_DEPTH) {
    warn(ix, "XSD_DEPTH_LIMIT", `Schema nesting deeper than ${MAX_DEPTH} levels was cut off at ${field.name}.`);
    return;
  }
  field.children = contentFields(ix, ct, key === null ? path : [...path, key], depth + 1, false);
}

function build(
  ix: Index,
  name: string,
  occ: Node,
  body: Node,
  path: string[],
  depth: number,
  optional: boolean,
): FieldDescriptor {
  const { min, max } = occursOf(occ);
  const field: FieldDescriptor = {
    name,
    xsdType: "anyType",
    minOccurs: optional ? 0 : min,
    maxOccurs: max,
    nillable: attr(occ, "nillable") === "true" || attr(body, "nillable") === "true",
  };
  const typeAttr = attr(body, "type");
  if (typeAttr !== null) {
    const local = localOf(typeAttr);
    field.xsdType = local;
    if (isXsd(ix, typeAttr)) return field;
    const ct = ix.complexTypes.get(local);
    if (ct !== undefined) {
      expandInto(ix, field, ct, `t:${local}`, path, depth);
      return field;
    }
    const st = ix.simpleTypes.get(local);
    if (st !== undefined) {
      field.xsdType = simpleBase(ix, st);
      return field;
    }
    if (BUILTINS.has(local)) return field;
    field.xsdType = "unknown";
    warn(ix, "XSD_TYPE_UNRESOLVED", `Type ${local} for field ${name} could not be resolved.`);
    return field;
  }
  const inlineCt = children(body, "complexType")[0];
  if (inlineCt !== undefined) {
    field.xsdType = "complexType";
    expandInto(ix, field, inlineCt, null, path, depth);
    return field;
  }
  const inlineSt = children(body, "simpleType")[0];
  if (inlineSt !== undefined) field.xsdType = simpleBase(ix, inlineSt);
  return field;
}

function describeElement(
  ix: Index,
  el: Node,
  path: string[],
  depth: number,
  optional: boolean,
): FieldDescriptor {
  const ref = attr(el, "ref");
  if (ref === null) {
    return build(ix, attr(el, "name") ?? "unknown", el, el, path, depth, optional);
  }
  const local = localOf(ref);
  const target = ix.elements.get(local);
  if (target === undefined) {
    warn(ix, "XSD_TYPE_UNRESOLVED", `Element reference ${local} could not be resolved.`);
    const { min, max } = occursOf(el);
    return {
      name: local,
      xsdType: "unknown",
      minOccurs: optional ? 0 : min,
      maxOccurs: max,
      nillable: attr(el, "nillable") === "true",
    };
  }
  const key = `e:${local}`;
  if (path.includes(key)) {
    warn(ix, "XSD_CYCLE", `Element ${local} refers to itself; it was not expanded again.`);
    const { min, max } = occursOf(el);
    const t = attr(target, "type");
    return {
      name: local,
      xsdType: t === null ? local : localOf(t),
      minOccurs: optional ? 0 : min,
      maxOccurs: max,
      nillable: attr(el, "nillable") === "true" || attr(target, "nillable") === "true",
    };
  }
  return build(ix, local, el, target, [...path, key], depth, optional);
}

function baseFields(ix: Index, base: string, path: string[], depth: number, optional: boolean): FieldDescriptor[] {
  if (isXsd(ix, base)) return [];
  const local = localOf(base);
  const ct = ix.complexTypes.get(local);
  if (ct !== undefined) {
    const key = `t:${local}`;
    if (path.includes(key)) {
      warn(ix, "XSD_CYCLE", `Type ${local} extends itself; it was not expanded again.`);
      return [];
    }
    return contentFields(ix, ct, [...path, key], depth, optional);
  }
  if (ix.simpleTypes.has(local) || BUILTINS.has(local)) return [];
  warn(ix, "XSD_TYPE_UNRESOLVED", `Base type ${local} could not be resolved.`);
  return [];
}

function groupFields(ix: Index, node: Node, path: string[], depth: number, optional: boolean): FieldDescriptor[] {
  const out: FieldDescriptor[] = [];
  for (const kind of ["sequence", "all", "choice"]) {
    for (const group of children(node, kind)) {
      const opt = optional || kind === "choice";
      for (const el of children(group, "element")) {
        out.push(describeElement(ix, el, path, depth, opt));
      }
      out.push(...groupFields(ix, group, path, depth, opt));
    }
  }
  return out;
}

function contentFields(ix: Index, ct: Node, path: string[], depth: number, optional: boolean): FieldDescriptor[] {
  const cc = children(ct, "complexContent")[0];
  if (cc === undefined) return groupFields(ix, ct, path, depth, optional);
  const out: FieldDescriptor[] = [];
  const ext = children(cc, "extension")[0];
  if (ext !== undefined) {
    const base = attr(ext, "base");
    if (base !== null) out.push(...baseFields(ix, base, path, depth, optional));
    out.push(...groupFields(ix, ext, path, depth, optional));
    return out;
  }
  const restriction = children(cc, "restriction")[0];
  if (restriction !== undefined) out.push(...groupFields(ix, restriction, path, depth, optional));
  return out;
}

/**
 * Build the field descriptors for one message direction.
 * Document style: the children of the global element elementQName.
 * RPC style: one field per message part.
 */
export function buildDescriptors(
  root: Record<string, unknown>,
  elementQName: string | null,
  ctx: DescriptorContext,
): DescriptorResult {
  const ix = buildIndex(root);
  let fields: FieldDescriptor[] = [];

  if (ctx.style === "rpc") {
    for (const part of ctx.parts) {
      if (part.name === "") continue;
      if (part.type !== null) {
        fields.push(build(ix, part.name, {}, { "@_type": part.type }, [], 1, false));
      } else if (part.element !== null) {
        const f = describeElement(ix, { "@_ref": part.element }, [], 1, false);
        fields.push({ ...f, name: part.name });
      }
    }
  } else if (elementQName !== null) {
    const local = localOf(elementQName);
    const el = ix.elements.get(local);
    if (el === undefined) {
      warn(ix, "XSD_TYPE_UNRESOLVED", `Element ${local} was not found in the schema.`);
    } else {
      fields = build(ix, local, el, el, [`e:${local}`], 0, false).children ?? [];
    }
  }

  return { fields, warnings: ix.warnings };
}
