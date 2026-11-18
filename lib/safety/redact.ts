// Redaction for transcripts and approvals. Fail closed: when unsure, mask.

// No /g or /y flag: those make RegExp.test stateful.
export const SENSITIVE = /pass(word)?|secret|token|api[-_]?key|authorization|credential|ssn/i;

const MASK = "[redacted]";
const MAX_DEPTH = 50;

function isSensitive(name: string): boolean {
  return SENSITIVE.test(name);
}

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redactValue(v: unknown, depth: number, ancestors: Set<object>): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return v;
    case "bigint":
      return v.toString();
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      // function, symbol: not JSON data; mask rather than guess.
      return MASK;
  }

  const obj = v as object;
  if (depth >= MAX_DEPTH || ancestors.has(obj)) return MASK;
  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? MASK : obj.toISOString();
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item: unknown) => redactValue(item, depth + 1, ancestors));
    }
    if (!isPlainObject(obj)) return MASK; // Map, Set, class instances, etc.
    const entries = Object.entries(obj as Record<string, unknown>).map(
      ([key, val]): [string, unknown] => [
        key,
        isSensitive(key) ? MASK : redactValue(val, depth + 1, ancestors),
      ],
    );
    // fromEntries defines own data properties, so a "__proto__" key is safe.
    return Object.fromEntries(entries);
  } catch {
    // Throwing getters, revoked proxies, etc.
    return MASK;
  } finally {
    ancestors.delete(obj);
  }
}

/** Deep, key-based redaction. Never throws and never mutates the input. */
export function redactJson(v: unknown): unknown {
  try {
    return redactValue(v, 0, new Set<object>());
  } catch {
    return MASK;
  }
}

function localName(qname: string): string {
  const i = qname.lastIndexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

// <name attr="v" attr2='v'  /> ; attribute values may contain ">" inside quotes.
const OPEN_TAG = /<([^\s/>!?=<]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const CLOSE_TAG = /<\/([^\s/>]+)\s*>/y;
const ATTR = /(\s+)([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/g;

function redactAttributes(attrs: string): string {
  return attrs.replace(
    ATTR,
    (_m: string, ws: string, name: string, eq: string, val: string) =>
      isSensitive(localName(name)) ? `${ws}${name}${eq}"${MASK}"` : `${ws}${name}${eq}${val}`,
  );
}

/**
 * Masks the content of every element whose local name matches SENSITIVE.
 * Tag text and attributes of that element are kept, except attributes whose
 * own name is sensitive. Anything that cannot be parsed with confidence has the
 * remainder of the document masked.
 */
export function redactXml(xml: string): string {
  let out = "";
  let i = 0;
  // Qualified names of open elements inside a masked region; empty when not masking.
  const masked: string[] = [];

  const failRest = (): string => (masked.length > 0 ? out : out + MASK);

  while (i < xml.length) {
    if (xml.charCodeAt(i) !== 60 /* < */) {
      const next = xml.indexOf("<", i);
      const end = next === -1 ? xml.length : next;
      if (masked.length === 0) out += xml.slice(i, end);
      i = end;
      continue;
    }

    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) return failRest();
      if (masked.length === 0) out += xml.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end === -1) return failRest();
      if (masked.length === 0) out += xml.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end === -1) return failRest();
      if (masked.length === 0) out += xml.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      // DOCTYPE and friends can carry entity values: drop entirely.
      const end = xml.indexOf(">", i + 2);
      if (end === -1) return failRest();
      i = end + 1;
      continue;
    }

    if (xml.startsWith("</", i)) {
      CLOSE_TAG.lastIndex = i;
      const m = CLOSE_TAG.exec(xml);
      if (!m) return failRest();
      if (masked.length > 0) {
        if (masked[masked.length - 1] !== m[1]) return failRest(); // mismatched nesting
        masked.pop();
        if (masked.length === 0) out += m[0];
      } else {
        out += m[0];
      }
      i = CLOSE_TAG.lastIndex;
      continue;
    }

    OPEN_TAG.lastIndex = i;
    const m = OPEN_TAG.exec(xml);
    if (!m) return failRest();
    const [, qname, attrs, selfClose] = m;
    i = OPEN_TAG.lastIndex;

    if (masked.length > 0) {
      if (selfClose !== "/") masked.push(qname);
      continue;
    }
    out += `<${qname}${redactAttributes(attrs)}${selfClose}>`;
    if (selfClose !== "/" && isSensitive(localName(qname))) {
      masked.push(qname);
      out += MASK;
    }
  }

  // Sensitive element never closed: its content is already masked; keep output.
  return out;
}

/** Returns s unchanged if it fits, otherwise a string of at most `max` UTF-16 units ending in "…". */
export function truncate(s: string, max: number): string {
  if (!(max > 0)) return "";
  const limit = Math.floor(max);
  if (limit < 1) return "";
  if (s.length <= limit) return s;
  let cut = s.slice(0, limit - 1);
  // Do not leave half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
