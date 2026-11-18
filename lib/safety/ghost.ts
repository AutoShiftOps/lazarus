// Pure ghost-mode response builder. Deterministic, never throws.
import { INTEGER_TYPES, NUMBER_TYPES } from "../soap/schema-generator";
import type { FieldDescriptor, OperationSchema } from "../soap/types";

/** Same nesting limit as lib/soap/xsd.ts. */
const MAX_DEPTH = 8;
const GHOST_DATE_TIME = "2000-01-01T00:00:00.000Z";

const GHOST_DATE = "2000-01-01";

function localName(xsdType: unknown): string {
  if (typeof xsdType !== "string") return "";
  const i = xsdType.lastIndexOf(":");
  return i >= 0 ? xsdType.slice(i + 1) : xsdType;
}

function scalar(field: FieldDescriptor): unknown {
  const t = localName(field.xsdType);
  if (INTEGER_TYPES.has(t)) return 1;
  if (NUMBER_TYPES.has(t)) return 0;
  if (t === "boolean") return true;
  if (t === "date") return GHOST_DATE;
  if (t === "dateTime") return GHOST_DATE_TIME;
  return `ghost-${String(field.name)}`;
}

function buildFields(
  fields: unknown,
  depth: number,
  ancestors: Set<unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(fields) || ancestors.has(fields)) return out;
  ancestors.add(fields);
  for (const f of fields as FieldDescriptor[]) {
    if (typeof f !== "object" || f === null || typeof f.name !== "string") continue;
    if (f.minOccurs === 0) continue; // optional -> omitted
    if (f.nillable === true) {
      out[f.name] = null;
      continue;
    }
    let value: unknown;
    if (Array.isArray(f.children)) {
      value = depth >= MAX_DEPTH ? {} : buildFields(f.children, depth + 1, ancestors);
    } else {
      value = scalar(f);
    }
    const isArray = f.maxOccurs === "unbounded" || (typeof f.maxOccurs === "number" && f.maxOccurs > 1);
    out[f.name] = isArray ? [value] : value;
  }
  ancestors.delete(fields);
  return out;
}

export function ghostResponse(op: OperationSchema): unknown {
  try {
    return buildFields(op?.outputDescriptor, 0, new Set());
  } catch {
    return {};
  }
}
