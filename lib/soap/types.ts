// lib/soap/types.ts
// Shared type definitions for the Lazarus summon pipeline.
// No runtime logic — types only.

// ─── Core domain types ────────────────────────────────────────────────────────

export type SoapVersion = "1.1" | "1.2";

export type BindingStyle =
  | "document/literal"
  | "rpc/literal"
  | "document/encoded"
  | "rpc/encoded"
  | "unknown";

/** Non-fatal issue captured during parsing or schema generation. message ≤ 200 chars. */
export type Warning = {
  code: string;
  message: string;
};

/**
 * Describes a single XSD element field, including nested complex types.
 * children is populated for complex type elements and preserves xsd:sequence order.
 */
export type FieldDescriptor = {
  name: string;
  xsdType: string; // e.g. "string", "int", "dateTime", or a complex type name
  minOccurs: number; // default 1
  maxOccurs: number | "unbounded"; // default 1
  nillable: boolean; // default false
  children?: FieldDescriptor[]; // present for complex types, in xsd:sequence order
};

/**
 * Fully serialisable description of one SOAP operation.
 * Zod schemas are rebuilt at runtime from inputDescriptor / outputDescriptor
 * via buildZodSchema — they are never stored here.
 */
export type OperationSchema = {
  name: string;
  soapVersions: [SoapVersion] | [SoapVersion, SoapVersion];
  preferredVersion: SoapVersion;
  bindingStyle: BindingStyle;
  /** Value of the SOAPAction HTTP header for this operation. */
  soapAction: string;
  /** Target namespace of the WSDL service. */
  targetNamespace: string;
  /** Local name of the Body child element used in requests. */
  inputElementName: string;
  /** Local name of the Body child element used in responses. */
  outputElementName: string;
  /** SOAP endpoint URL. */
  endpointAddress: string;
  elementFormDefault: "qualified" | "unqualified";
  /** Input fields in xsd:sequence order. */
  inputDescriptor: FieldDescriptor[];
  /** Output fields in xsd:sequence order. */
  outputDescriptor: FieldDescriptor[];
  warnings: Warning[];
};

export type ServicePort = {
  name: string;
  /** SOAP endpoint URL. */
  address: string;
  operations: OperationSchema[];
};

export type ServiceDefinition = {
  /** Set after the registry upsert; absent before persistence. */
  id?: string;
  name: string;
  wsdlUrl: string;
  ports: ServicePort[];
  warnings: Warning[];
};

// ─── Error types ──────────────────────────────────────────────────────────────

export type ErrorCode =
  | "INVALID_REQUEST"
  | "SSRF_BLOCKED"
  | "WSDL_TOO_LARGE"
  | "WSDL_FETCH_FAILED"
  | "TIMEOUT"
  | "WSDL_PARSE_FAILED"
  | "REGISTRY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type LazarusError = {
  code: ErrorCode;
  message: string;
  /** Internal diagnostic data — never sent to clients. */
  detail?: unknown;
};

export type ValidationError = {
  type: "validationError";
  missingFields: string[];
};

export type FaultError = {
  type: "fault";
  faultCode: string;
  faultString: string;
  detail?: string;
};
