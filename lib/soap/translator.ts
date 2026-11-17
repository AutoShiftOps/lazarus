// lib/soap/translator.ts
// JSON -> SOAP envelope translation (Requirement 5). Pure, no I/O.

import { buildZodSchema } from "./schema-generator";
import type {
  EnvelopeResult,
  FieldDescriptor,
  OperationSchema,
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
