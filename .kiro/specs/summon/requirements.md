# Requirements Document

## Introduction

The "summon" feature allows a user to submit a WSDL URL and have Lazarus fetch, parse and
register the described SOAP service. Every SOAP operation is discovered and each operation's
input/output message is converted to a JSON Schema (backed by zod). The result is stored in
the service registry under a short, stable id so subsequent features (MCP endpoint, UI, transcripts)
can look it up. The feature covers SOAP 1.1 and 1.2 with document/literal and rpc/literal binding styles; rpc/encoded bindings are detected and flagged as unsupported rather than silently ignored. Unreachable or malformed WSDLs are rejected with a human-readable error.

---

## Glossary

- **Lazarus**: The application being built; raises dead SOAP services as MCP servers.
- **Summon_API**: The Next.js App Router route handler at `app/api/summon/route.ts`.
- **WSDL_Fetcher**: The module in `lib/soap/` responsible for fetching WSDL documents over HTTP/HTTPS.
- **WSDL_Parser**: The module in `lib/soap/` responsible for parsing a raw WSDL XML string into an internal `ServiceDefinition`.
- **Schema_Generator**: The module in `lib/soap/` responsible for converting WSDL message parts into JSON Schema objects via zod.
- **Translator**: The module at `lib/soap/translator.ts`; the sole location where JSON ↔ SOAP-envelope conversion happens.
- **Registry**: The Upstash Redis-backed storage in `lib/registry/`; stores `ServiceDefinition` records keyed by a short id.
- **ServiceDefinition**: The internal representation of a parsed WSDL — services, ports, operations, and JSON Schemas.
- **OperationSchema**: A pair of zod-inferred JSON Schema objects (input and output) for one SOAP operation.
- **OperationSchema.soapVersions**: An array field on `OperationSchema` listing the SOAP versions (`"1.1"`, `"1.2"`, or both) available for an operation.
- **OperationSchema.preferredVersion**: A field on `OperationSchema` indicating which SOAP version to use for outbound calls; defaults to `"1.1"` when both versions are available.
- **SOAP_Envelope**: A well-formed XML document conforming to the SOAP 1.1 or 1.2 namespace that wraps a SOAP call.
- **Client**: A human user interacting with the Lazarus UI or a programmatic caller of the Summon API.
- **SSRF**: Server-Side Request Forgery; an attack where a server is tricked into making requests to internal or unintended network destinations.

---

## Requirements

### Requirement 1: Fetch WSDL document

**User Story:** As a Client, I want to submit a WSDL URL so that Lazarus can retrieve the service description.

#### Acceptance Criteria

1. WHEN the Client submits an HTTP or HTTPS WSDL URL that passes validation, THE WSDL_Fetcher SHALL retrieve the WSDL document within 10 seconds.
2. IF the WSDL_Fetcher does not receive a response within 10 seconds, THEN THE Summon_API SHALL return an error with the message "The séance timed out — the service did not respond in time."
3. IF the URL returns an HTTP status other than 200, THEN THE Summon_API SHALL return an error that includes the HTTP status code received and a description identifying it as an unreachable or rejected endpoint.
4. IF the URL is syntactically invalid or uses a scheme other than HTTP or HTTPS, THEN THE Summon_API SHALL return an error with the message "Invalid URL — only HTTP and HTTPS are supported."
5. THE WSDL_Fetcher SHALL follow HTTP redirects up to a maximum of 5 hops.
6. IF the number of redirects exceeds 5, THEN THE Summon_API SHALL return an error explaining that too many redirects were encountered.

---

### Requirement 2: Validate WSDL content

**User Story:** As a Client, I want malformed or non-WSDL documents to be rejected immediately so that I receive a clear explanation instead of a silent failure.

#### Acceptance Criteria

1. WHEN the WSDL_Parser receives a fetched document, THE WSDL_Parser SHALL verify the root element is a `<definitions>` element in the WSDL 1.1 namespace (`http://schemas.xmlsoap.org/wsdl/`); this root-element check is performed solely in the WSDL_Parser and not repeated in the WSDL_Fetcher.
2. IF the document is not valid XML, THEN THE WSDL_Parser SHALL return a structured parse error that includes the line and column of the first syntax violation.
3. IF the document is valid XML but its root element is a `<description>` element in the WSDL 2.0 namespace (`http://www.w3.org/ns/wsdl`), THEN THE WSDL_Parser SHALL return an error with the message "WSDL 2.0 is not supported yet." IF the document is valid XML but its root element is neither a WSDL 1.1 `<definitions>` nor a WSDL 2.0 `<description>`, THEN THE WSDL_Parser SHALL return an error message indicating the document is not a recognised WSDL document.
4. IF the WSDL contains no service definitions, THEN THE WSDL_Parser SHALL return an error message indicating that no services were found in the WSDL.
5. THE WSDL_Parser SHALL accept inline XML Schema definitions (`<types>` element) and attempt to resolve externally referenced schemas via `schemaLocation`, with a resolution timeout of 10 seconds per schema URL.
6. IF an externally referenced schema cannot be fetched within 10 seconds or returns a non-200 response, THEN THE WSDL_Parser SHALL proceed with parsing using only the schema definitions already available and include a warning in the structured result indicating which `schemaLocation` URLs failed to resolve.

---

### Requirement 3: Parse SOAP 1.1 and 1.2 bindings

**User Story:** As a Client, I want both SOAP 1.1 and SOAP 1.2 services to be discovered so that I am not locked out of either generation of legacy service.

#### Acceptance Criteria

1. WHEN the WSDL_Parser processes a WSDL document, THE WSDL_Parser SHALL include in the `ServiceDefinition` only operations from bindings whose transport namespace is `http://schemas.xmlsoap.org/soap/http` (SOAP 1.1) or `http://www.w3.org/2003/05/soap/bindings/HTTP/` (SOAP 1.2).
2. WHEN both a SOAP 1.1 binding and a SOAP 1.2 binding reference the same port type and expose an operation with the same name, THE WSDL_Parser SHALL produce a single `OperationSchema` for that operation whose `soapVersions` field lists both `"1.1"` and `"1.2"`, and whose `preferredVersion` field is set to `"1.1"`.
3. WHEN a SOAP binding is processed for an operation that has no counterpart in another version's binding, THE WSDL_Parser SHALL produce a single `OperationSchema` whose `soapVersions` field contains only the version of that binding and whose `preferredVersion` field equals that version.
4. WHEN parsing a binding, THE WSDL_Parser SHALL record the binding style on each `OperationSchema` as one of `"document/literal"`, `"rpc/literal"`, `"document/encoded"`, or `"unknown"`. IF the style is `"rpc/encoded"`, THE WSDL_Parser SHALL record it as `"rpc/encoded"` and add a warning entry to the `ServiceDefinition` warnings list indicating that `rpc/encoded` is not supported for live calls. IF the style cannot be determined, THE WSDL_Parser SHALL record it as `"unknown"`.
5. IF a binding's transport namespace does not match the SOAP 1.1 or 1.2 transport namespaces, THEN THE WSDL_Parser SHALL skip that binding, exclude its operations from the `ServiceDefinition`, and include the binding's local name in a warnings list on the `ServiceDefinition`.

---

### Requirement 4: Generate JSON Schema for every operation

**User Story:** As an agent builder, I want every SOAP operation exposed as a typed JSON Schema so that my MCP client can validate inputs and outputs without touching any XML.

#### Acceptance Criteria

1. WHEN the WSDL_Parser has produced a `ServiceDefinition`, THE Schema_Generator SHALL produce an `OperationSchema` for every operation in every port of every service in that definition.
2. WHEN generating an `OperationSchema`, THE Schema_Generator SHALL convert each WSDL message part to an equivalent zod schema type and export the corresponding JSON Schema object derived from that zod schema.
3. THE Schema_Generator SHALL map XSD primitive types to zod types as follows: `string` → `z.string()`; `int`, `integer`, `long`, or `short` → `z.number().int()`; `decimal`, `float`, or `double` → `z.number()`; `boolean` → `z.boolean()`; `dateTime` → `z.string().datetime({ offset: true, local: true })` (accepting both offset and local datetime strings); `date` → `z.string()` (accepting ISO 8601 date strings of the form `YYYY-MM-DD`).
4. WHEN an XSD element has `minOccurs="0"`, THE Schema_Generator SHALL mark the corresponding zod field as `.optional()`. WHEN an XSD element is marked `nillable="true"`, THE Schema_Generator SHALL mark the corresponding zod field as `.nullable()`. WHEN an element has both `minOccurs="0"` and `nillable="true"`, THE Schema_Generator SHALL mark it as `.optional().nullable()`.
5. WHEN an XSD element has `maxOccurs` greater than 1 or equal to `"unbounded"`, THE Schema_Generator SHALL wrap the corresponding zod field in `z.array(...)`.
6. IF an XSD type is not covered by any mapping rule in criterion 3, THEN THE Schema_Generator SHALL represent that field as `z.unknown()` and add the unmapped XSD type name as a string entry to a `warnings` array on the `OperationSchema`.

---

### Requirement 5: JSON ↔ SOAP envelope translation

**User Story:** As an agent builder, I want JSON tool-call arguments translated to a valid SOAP envelope and SOAP responses translated back to JSON so that my agent never has to deal with XML.

#### Acceptance Criteria

1. THE Translator SHALL be the only module in Lazarus that constructs or parses SOAP envelopes; no other module SHALL build or read envelope XML directly.
2. WHEN given a JSON arguments object and an `OperationSchema`, THE Translator SHALL produce a SOAP envelope that uses the namespace and version (1.1 or 1.2) recorded on the `OperationSchema`, contains a correctly named `Body` element wrapping the operation arguments, and is valid XML with balanced tags and properly declared namespaces.
3. IF a JSON arguments object is missing one or more fields marked required in the `OperationSchema`, THEN THE Translator SHALL return a structured error object with a `validationError` field listing the missing field names without producing a SOAP envelope.
4. WHEN given a SOAP response envelope and an `OperationSchema`, THE Translator SHALL return a plain JSON object whose keys and value types correspond to the fields defined in the output schema; elements with `xsi:nil="true"` SHALL be mapped to `null`, and absent XML elements SHALL be omitted from the returned object entirely rather than included as `null` or `undefined`.
5. WHEN a JSON arguments object containing only values representable as XML text nodes is translated via `toEnvelope` and the resulting envelope is translated via `fromEnvelope` with the same `OperationSchema`, THE Translator SHALL return a JSON object deeply equal to the original input.
6. IF the SOAP response contains a `<Fault>` element, THEN THE Translator SHALL return a structured error object with `faultCode`, `faultString`, and optional `detail` fields, mapping SOAP 1.1 `faultcode`/`faultstring` and SOAP 1.2 `env:Code`/`env:Reason` to those fields respectively.
7. THE Translator SHALL escape the characters `<`, `>`, `&`, `"`, and `'` in all field values before inserting them into an envelope, such that injected XML markup in any field value is rendered as character data and does not alter the envelope structure.

---

### Requirement 6: Persist service in the registry

**User Story:** As a Client, I want a successfully parsed service to be saved under a short id so that I can reference it in later API calls.

#### Acceptance Criteria

1. WHEN a WSDL is successfully fetched and parsed, THE Registry SHALL store the resulting `ServiceDefinition` in Upstash Redis under a unique, URL-safe id of 8–12 alphanumeric characters generated using a cryptographically random method.
2. THE Registry SHALL store the original WSDL URL alongside the `ServiceDefinition` as a field in the same Redis entry, with a maximum URL length of 2048 characters.
3. IF a `ServiceDefinition` with the same WSDL URL already exists in the registry, THEN THE Registry SHALL return the existing id without writing a new entry.
4. THE Registry SHALL store the `ServiceDefinition` as a JSON-serialised string with a TTL of 2592000 seconds (30 days), after which the entry expires automatically.
5. WHEN the Registry encounters a Redis connection error during a store or lookup operation, THE Summon_API SHALL respond with HTTP 503 and an error message indicating registry unavailability.
6. IF the WSDL URL exceeds 2048 characters, THEN THE Summon_API SHALL reject the request with HTTP 400 and an error message indicating the URL is too long, without attempting to store or parse the WSDL.

---

### Requirement 7: Summon API response contract

**User Story:** As a Client, I want the summon endpoint to return a predictable JSON response so that I can display the result or handle errors in the UI without parsing ad-hoc formats.

#### Acceptance Criteria

1. WHEN a summon request succeeds, THE Summon_API SHALL respond with HTTP 200 and a JSON body containing: `id` (string), `name` (string — the WSDL service name), `operations` (array of at most 500 operation name strings), `wsdlUrl` (string), and `mcpUrl` (string — the absolute URL of the MCP endpoint for this service, constructed from the origin of the incoming request, of the form `https://{host}/api/mcp/{id}`).
2. IF the WSDL URL is unreachable or the upstream server returns a non-200 response, THEN THE Summon_API SHALL respond with HTTP 502 and a JSON body containing `error` (string — human-readable message) and `code` set to `WSDL_FETCH_FAILED`.
3. THE Summon_API SHALL accept `Content-Type: application/json` POST requests with a body containing `{ "wsdlUrl": string }`.
4. IF the request body is missing the `wsdlUrl` field, it is not a string, or it is not a valid absolute URL with an `http` or `https` scheme, THEN THE Summon_API SHALL respond with HTTP 400 and a JSON body containing `error` (string — human-readable message) and `code` set to `INVALID_REQUEST`.
5. THE Summon_API SHALL validate the request body with a zod schema before any fetch or parse logic executes.
6. IF the fetched content cannot be parsed as a valid WSDL document, THEN THE Summon_API SHALL respond with HTTP 422 and a JSON body containing `error` (string — human-readable message) and `code` set to `WSDL_PARSE_FAILED`.

---

### Requirement 8: WSDL fixture contract tests

**User Story:** As a developer, I want the two canonical demo WSDLs to be covered by contract tests so that regressions in parsing or schema generation are caught immediately.

#### Acceptance Criteria

1. WHEN the WSDL_Parser parses the Calculator WSDL fixture loaded from the local file `fixtures/calculator.wsdl` (without making any network requests), THE WSDL_Parser SHALL produce a `ServiceDefinition` whose deduplicated operations list contains exactly and only the names `Add`, `Subtract`, `Multiply`, and `Divide`.
2. WHEN the WSDL_Parser parses the CountryInfoService WSDL fixture loaded from the local file `fixtures/countryinfo.wsdl` (without making any network requests), THE WSDL_Parser SHALL produce a `ServiceDefinition` whose operations list contains at least the names `CountryFlag`, `CountryName`, `CapitalCity`, and `CountryCurrency`, and the total deduplicated operation count is at least 4.
3. WHEN the Schema_Generator generates `OperationSchema` objects for all operations in the Calculator and CountryInfoService fixtures, every generated zod schema field SHALL use one of the following types: `z.string()`, `z.number()`, `z.number().int()`, `z.boolean()`, `z.string().datetime({ offset: true, local: true })`, `z.array(...)`, `z.object(...)`, or `.optional()` / `.nullable()` variants of the above; and no field SHALL use `z.unknown()`.
4. WHEN a valid JSON input object conforming to an `OperationSchema` from either fixture is passed to `Translator.toEnvelope` and the resulting SOAP envelope is passed to `Translator.fromEnvelope` with the same `OperationSchema`, THE result SHALL be deeply equal to the original input object with no missing or extra keys.
5. ALL contract tests in Requirement 8 SHALL read fixture files from the local filesystem and SHALL NOT make any outbound network requests.

---

### Requirement 9: Error transparency

**User Story:** As a Client, I want every failure mode to surface a descriptive, user-facing message so that I can diagnose problems without reading server logs.

#### Acceptance Criteria

1. IF THE Summon_API returns any error response (4xx or 5xx), THEN THE Summon_API SHALL include an `error` field in the response body containing a non-empty string of at most 500 characters that identifies the failure cause without including stack traces, file paths, or internal system identifiers.
2. IF an unexpected exception is thrown during summon processing, THEN THE Summon_API SHALL log the full stack trace server-side and return HTTP 500 with a response body containing `code` set to `INTERNAL_ERROR` and an `error` field that does not contain stack trace text, file paths, or internal system identifiers.
3. WHEN THE Summon_API returns a successful response, THE Summon_API SHALL include a `warnings` array containing at most 50 entries, where each entry contains a `code` string and a `message` string of at most 200 characters describing a non-fatal issue encountered during parsing; the array SHALL be empty if no non-fatal issues were encountered.

---

### Requirement 10: SSRF protection and response size cap

**User Story:** As a platform operator, I want the WSDL fetcher to refuse requests that target internal infrastructure and to cap the size of WSDL responses, so that Lazarus cannot be used as a proxy to scan private networks or exhaust server memory.

#### Acceptance Criteria

1. BEFORE making an outbound HTTP request, THE WSDL_Fetcher SHALL resolve the hostname in the WSDL URL to an IP address and reject the request if the resolved address falls within any of the following ranges: unspecified (0.0.0.0/8, ::), loopback (127.0.0.0/8, ::1), private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7), link-local (169.254.0.0/16, fe80::/10), cloud-metadata (169.254.169.254/32, fd00:ec2::254/128), or IPv4-mapped IPv6 (::ffff:0:0/96). THE WSDL_Fetcher SHALL then open the TCP connection directly to the validated IP address rather than re-resolving the hostname, so that a DNS rebinding attack cannot substitute a different address after the check.
2. IF the resolved IP address falls within a blocked range, THEN THE Summon_API SHALL respond with HTTP 400 and error code `SSRF_BLOCKED`, without making the outbound request.
3. THE WSDL_Fetcher SHALL apply the same blocked-range check to every IP address encountered during redirect following; IF any redirect destination resolves to a blocked address, THE Summon_API SHALL respond with HTTP 400 and error code `SSRF_BLOCKED`.
4. THE WSDL_Fetcher SHALL stop reading the response body once 5 242 880 bytes (5 MB) have been received and SHALL reject the response with HTTP 422 and error code `WSDL_TOO_LARGE` if the body exceeds that limit.
5. IF the `Content-Length` response header is present and its value exceeds 5 242 880 bytes, THEN THE WSDL_Fetcher SHALL reject the response immediately without reading the body, responding with HTTP 422 and error code `WSDL_TOO_LARGE`.
