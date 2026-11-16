// lib/soap/parser.ts
// WSDL parser pipeline. Stage 1: guardXml. Stage 2: inspectDocument.

import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { LazarusError } from "./types";

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
