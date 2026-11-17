// lib/soap/schema-generator.ts
// XSD type -> zod mapping (Requirement 4.3). Pure, no I/O.

import { z } from "zod";
import type { FieldDescriptor, OperationSchema, ServiceDefinition } from "./types";

export type OperationSchemaMap = Map<string, OperationSchema>;

export const STRING_TYPES: ReadonlySet<string> = new Set([
  "string",
  "normalizedString",
  "token",
  "anyURI",
  "base64Binary",
  "hexBinary",
  "time",
  "duration",
  "language",
  "Name",
  "NCName",
  "ID",
  "QName",
]);

// Note: JSON numbers lose precision above 2^53, so large `long` values
// (and unsignedLong) are not guaranteed to round-trip exactly.
export const INTEGER_TYPES: ReadonlySet<string> = new Set([
  "int",
  "integer",
  "long",
  "short",
  "byte",
  "unsignedByte",
  "unsignedShort",
  "unsignedInt",
  "unsignedLong",
  "nonNegativeInteger",
  "positiveInteger",
  "nonPositiveInteger",
  "negativeInteger",
]);

export const NUMBER_TYPES: ReadonlySet<string> = new Set(["decimal", "float", "double"]);

/** Types the parser has already warned about; map to unknown silently. */
const SILENT_UNKNOWN_TYPES = new Set(["anyType", "complexType", "unknown"]);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/;

export function xsdTypeToZod(xsdType: string): {
  schema: z.ZodTypeAny;
  warning?: string;
} {
  if (STRING_TYPES.has(xsdType)) return { schema: z.string() };
  if (INTEGER_TYPES.has(xsdType)) return { schema: z.number().int() };
  if (NUMBER_TYPES.has(xsdType)) return { schema: z.number() };
  if (xsdType === "boolean") return { schema: z.boolean() };
  if (xsdType === "dateTime") {
    return { schema: z.string().datetime({ offset: true, local: true }) };
  }
  if (xsdType === "date") return { schema: z.string().regex(DATE_REGEX) };
  if (SILENT_UNKNOWN_TYPES.has(xsdType)) return { schema: z.unknown() };
  return { schema: z.unknown(), warning: xsdType };
}

function buildFieldSchema(field: FieldDescriptor): z.ZodTypeAny {
  let schema: z.ZodTypeAny = field.children
    ? buildZodSchema(field.children)
    : xsdTypeToZod(field.xsdType).schema;

  if (field.maxOccurs === "unbounded" || field.maxOccurs > 1) {
    schema = z.array(schema);
  }
  if (field.minOccurs === 0) schema = schema.optional();
  if (field.nillable) schema = schema.nullable();
  return schema;
}

/** Builds a strict zod object schema from a descriptor tree (Requirements 4.2, 4.4, 4.5). */
export function buildZodSchema(
  descriptors: FieldDescriptor[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of descriptors) {
    shape[field.name] = buildFieldSchema(field);
  }
  return z.strictObject(shape);
}

function collectUnmappedTypes(
  descriptors: FieldDescriptor[],
  out: Set<string>,
): void {
  for (const field of descriptors) {
    if (field.children) {
      collectUnmappedTypes(field.children, out);
    } else {
      const { warning } = xsdTypeToZod(field.xsdType);
      if (warning !== undefined) out.add(warning);
    }
  }
}

/** Generates an OperationSchemaMap (copies) for every operation in the service (Requirements 4.1, 4.6). */
export function generateSchemas(service: ServiceDefinition): OperationSchemaMap {
  const result: OperationSchemaMap = new Map();

  for (const port of service.ports) {
    for (const original of port.operations) {
      const op = structuredClone(original);

      const unmapped = new Set<string>();
      collectUnmappedTypes(op.inputDescriptor, unmapped);
      collectUnmappedTypes(op.outputDescriptor, unmapped);

      const seen = new Set(op.warnings.map((w) => w.message));
      for (const name of unmapped) {
        const message = `XSD type ${name} is not mapped; treated as unknown.`.slice(0, 200);
        if (seen.has(message)) continue;
        seen.add(message);
        op.warnings.push({ code: "XSD_TYPE_UNMAPPED", message });
      }

      let key = op.name;
      let n = 2;
      while (result.has(key)) key = `${op.name}_${n++}`;
      result.set(key, op);
    }
  }

  return result;
}
