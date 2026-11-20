// lib/ui/form-model.ts
// FieldDescriptor[] -> form field tree, and form values -> tool arguments.
// Pure, no I/O (Requirements 4.1, 4.2).

import { INTEGER_TYPES, NUMBER_TYPES } from "../soap/schema-generator";
import type { FieldDescriptor } from "../soap/types";

export type FormField =
  | {
      kind: "text" | "number" | "boolean" | "datetime";
      name: string;
      required: boolean;
      nillable: boolean;
      list: boolean;
    }
  | {
      kind: "group";
      name: string;
      required: boolean;
      nillable: boolean;
      list: boolean;
      children: FormField[];
    };

/** Thrown by toArguments when a value cannot be turned into a valid argument. */
export class FormError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "FormError";
    this.field = field;
  }
}

function isList(d: FieldDescriptor): boolean {
  return d.maxOccurs === "unbounded" || d.maxOccurs > 1;
}

function leafKind(xsdType: string): "text" | "number" | "boolean" | "datetime" {
  if (INTEGER_TYPES.has(xsdType) || NUMBER_TYPES.has(xsdType)) return "number";
  if (xsdType === "boolean") return "boolean";
  if (xsdType === "dateTime") return "datetime";
  return "text";
}

export function toFormModel(desc: FieldDescriptor[]): FormField[] {
  return desc.map((d): FormField => {
    const base = {
      name: d.name,
      required: d.minOccurs >= 1,
      nillable: d.nillable,
      list: isList(d),
    };
    if (d.children) {
      return { ...base, kind: "group", children: toFormModel(d.children) };
    }
    return { ...base, kind: leafKind(d.xsdType) };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Result of converting one field: a value to include, or the drop marker. */
const DROP: unique symbol = Symbol("drop");

function convertListText(field: FormField, raw: unknown, path: string): unknown {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return field.required ? [] : DROP;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FormError(path, "Not valid JSON. Enter a JSON array, for example [1, 2].");
  }
  if (parsed === null && field.nillable) return null;
  if (!Array.isArray(parsed)) throw new FormError(path, "Must be a JSON array.");
  return parsed;
}

function convertLeaf(field: FormField, raw: unknown, path: string): unknown {
  switch (field.kind) {
    case "number": {
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) throw new FormError(path, "Must be a finite number.");
        return raw;
      }
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "") return DROP;
      const n = Number(text);
      if (!Number.isFinite(n)) throw new FormError(path, "Must be a number.");
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      return DROP;
    }
    default: {
      if (typeof raw !== "string") return DROP;
      if (raw === "" && !field.required) return DROP;
      return raw;
    }
  }
}

function convertField(field: FormField, raw: unknown, path: string): unknown {
  if (raw === null) return field.nillable ? null : DROP;
  if (raw === undefined) {
    if (field.kind === "group" && field.required && !field.list) {
      return convertObject(field.children, {}, path);
    }
    return field.list && field.required ? [] : DROP;
  }

  if (field.list) return convertListText(field, raw, path);

  if (field.kind === "group") {
    if (!isRecord(raw)) return DROP;
    const obj = convertObject(field.children, raw, path);
    if (!field.required && Object.keys(obj).length === 0) return DROP;
    return obj;
  }
  return convertLeaf(field, raw, path);
}

function convertObject(
  model: FormField[],
  values: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of model) {
    const path = prefix === "" ? field.name : `${prefix}.${field.name}`;
    const result = convertField(field, values[field.name], path);
    if (result !== DROP) out[field.name] = result;
  }
  return out;
}

/**
 * Converts raw form values into tool arguments: drops empty optionals,
 * converts number strings to numbers, parses list fields from JSON text,
 * and keeps `null` only for nillable fields where it was set explicitly.
 * Throws FormError (field + message) on bad input.
 */
export function toArguments(model: FormField[], values: unknown): unknown {
  return convertObject(model, isRecord(values) ? values : {}, "");
}
