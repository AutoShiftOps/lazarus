# Implementation Plan: Summon

## Overview

Build the full "summon" pipeline: install dependencies, define shared types, implement SSRF-safe WSDL fetching, WSDL parsing, JSON Schema generation, SOAP envelope translation, Redis-backed registry, and the Next.js API route. Property-based and contract tests are woven in alongside each module.

## Tasks

- [x] 1. Install dependencies and configure test tooling
  - Add `soap`, `@upstash/redis`, `zod@^4`, `nanoid` to `dependencies` in `package.json`
  - Add `vitest`, `fast-check`, `@vitest/coverage-v8`, `@playwright/test` to `devDependencies`
  - Add `vitest.config.ts` with `globals: true`, `environment: "node"`, and `include: ["tests/**/*.test.ts"]`
  - Add `test` script (`vitest --run`) and `e2e` script (`playwright test`) to `package.json`
  - Add `playwright.config.ts` pointing at `e2e/` with `baseURL: "http://localhost:3000"`
  - _Requirements: 8 (test infrastructure)_

- [x] 2. Define shared types
  - [x] 2.1 Create `lib/soap/types.ts` with all exported types
    - `SoapVersion`, `BindingStyle`, `Warning`, `FieldDescriptor`, `OperationSchema`, `ServicePort`, `ServiceDefinition`
    - `ErrorCode`, `LazarusError`, `ValidationError`, `FaultError`
    - No runtime logic — types only
    - _Requirements: 3.2, 3.3, 3.4, 4.2, 4.3, 5.1, 6.1, 7.1_

- [x] 3. Typed environment variables
  - [x] 3.1 Create `lib/env.ts`
    - Define `EnvSchema` with `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NODE_ENV`
    - Export `getEnv(): Env` that calls `EnvSchema.parse(process.env)`
    - _Requirements: 6.5 (registry availability implies env config)_

- [ ] 4. SSRF-safe WSDL fetcher
  - [x] 4.1 Implement `lib/soap/fetcher.ts` — `isBlockedIp`
    - Pure function; checks unspecified, loopback, private, link-local, cloud-metadata, IPv4-mapped IPv6 ranges using bitwise integer arithmetic
    - No external dependencies inside this function
    - _Requirements: 10.1_
  - [ ] 4.2 Implement `lib/soap/fetcher.ts` — `safeFetch` and `fetchWsdl`
    - `safeFetch`: shared HTTP primitive with SSRF IP check, custom `lookup` callback that dials the validated IP (DNS-rebinding defence), 10 s timeout, 5 MB body cap, redirect following (max 5 hops)
    - `fetchWsdl`: validates URL scheme, delegates to `safeFetch`, maps all error cases to `LazarusError`
    - Export `FetchResult` type
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.1, 10.2, 10.3, 10.4, 10.5_
  - [x] 4.3 Write unit tests for `isBlockedIp` in `tests/soap/fetcher.test.ts`
    - Test CIDR boundary values for each blocked range
    - Test public IPs that must not be blocked
    - _Requirements: 10.1_
  - [x] 4.4 Write property test for `isBlockedIp` — Property 5
    - **Property 5: IP classifier correctness**
    - Generate IPs inside each blocked range; assert `isBlockedIp` returns `true`
    - Generate IPs outside all blocked ranges; assert `isBlockedIp` returns `false`
    - Minimum 100 iterations
    - **Validates: Requirements 10.1**
  - [ ] 4.5 Write unit tests for `fetchWsdl` in `tests/soap/fetcher.test.ts`
    - Mock HTTP server for redirect-limit, non-200, timeout, body-size-cap, and SSRF-blocked cases
    - Assert that a WSDL whose `schemaLocation` points to `http://127.0.0.1/evil.xsd` is blocked before any outbound request
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 10.2, 10.3, 10.4, 10.5_

- [ ] 5. WSDL parser
  - [ ] 5.1 Implement `lib/soap/parser.ts` — `parseWsdl`
    - Use the `soap` package's `WSDL` class to parse the XML; catch and re-throw XML syntax errors with line/column
    - Check root element namespace: WSDL 1.1 `definitions`, WSDL 2.0 `description`, or unrecognised
    - Reject documents with no `<service>` elements
    - Iterate bindings; keep only SOAP 1.1 (`http://schemas.xmlsoap.org/soap/http`) and SOAP 1.2 (`http://www.w3.org/2003/05/soap/bindings/HTTP/`) transports; add `UNSUPPORTED_BINDING` warnings for others
    - Deduplicate operations that share `(portTypeName, operationName)` across SOAP versions; set `soapVersions` and `preferredVersion`
    - Classify `bindingStyle`; flag `rpc/encoded` with warnings
    - Resolve external `schemaLocation` URLs via `safeFetch` with 10 s timeout each; on failure add `SCHEMA_FETCH_FAILED` warning and continue
    - Return `ParseResult`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5_
  - [ ]* 5.2 Write unit tests for `parseWsdl` in `tests/soap/parser.test.ts`
    - WSDL 1.1 accepted, WSDL 2.0 rejected, non-WSDL XML rejected, no-service error
    - SOAP 1.1 and 1.2 binding deduplication, rpc/encoded warning, unsupported transport skip
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 6. JSON Schema generator
  - [ ] 6.1 Implement `lib/soap/schema-generator.ts` — `xsdTypeToZod`
    - Pure function mapping each XSD primitive (`string`, `int`, `integer`, `long`, `short`, `decimal`, `float`, `double`, `boolean`, `dateTime`, `date`) to the correct zod type per the design table
    - Fall through to `z.unknown()` for unmapped types; push warning
    - _Requirements: 4.3_
  - [ ] 6.2 Implement `lib/soap/schema-generator.ts` — `buildZodSchema` and `generateSchemas`
    - `buildZodSchema(descriptors: FieldDescriptor[])`: apply `optional()`, `nullable()`, `z.array()` modifiers as required by `minOccurs`, `nillable`, `maxOccurs`; recurse into `children` for complex types
    - `generateSchemas(service: ServiceDefinition): OperationSchemaMap`: iterate every port's operations and annotate each `OperationSchema` with its `inputDescriptor` and `outputDescriptor`
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_
  - [ ]* 6.3 Write unit tests for `xsdTypeToZod` and `buildZodSchema` in `tests/soap/schema-generator.test.ts`
    - Each XSD type mapping; each modifier combination; `z.unknown()` fallback
    - _Requirements: 4.3, 4.4, 4.5, 4.6_
  - [ ] 6.4 Write property test for `xsdTypeToZod` — Property 8
    - **Property 8: XSD type mapping completeness**
    - For each supported XSD type name, assert `xsdTypeToZod` produces a schema whose `safeParse` succeeds on a valid value and never returns a `z.unknown()` instance
    - Minimum 100 iterations
    - **Validates: Requirements 4.3**
  - [ ] 6.5 Write property test for modifier combinations — Property 9
    - **Property 9: Schema modifiers preserve value semantics**
    - For all `(minOccurs, nillable, maxOccurs)` combinations, assert the produced zod schema accepts exactly the right value set
    - Minimum 100 iterations
    - **Validates: Requirements 4.4, 4.5**

- [ ] 7. SOAP envelope translator
  - [ ] 7.1 Implement `lib/soap/translator.ts` — `xmlEscape` and `toEnvelope`
    - `xmlEscape`: escape `<`, `>`, `&`, `"`, `'` in all leaf values before insertion
    - `toEnvelope`: validate `args` via `buildZodSchema(schema.inputDescriptor).safeParse`; select SOAP 1.1 or 1.2 namespace from `schema.preferredVersion`; iterate `inputDescriptor` in order to build child elements; return `EnvelopeResult`
    - _Requirements: 5.1, 5.2, 5.3, 5.7_
  - [ ] 7.2 Implement `lib/soap/translator.ts` — `normaliseFault` and `fromEnvelope`
    - `normaliseFault`: map SOAP 1.1 `faultcode`/`faultstring` and SOAP 1.2 `env:Code`/`env:Reason` to `FaultError`
    - `fromEnvelope`: parse XML, detect `<Fault>`, walk response body per `outputDescriptor`, handle `xsi:nil="true"` → `null`, absent elements → omit key; return `ParseEnvelopeResult`
    - _Requirements: 5.4, 5.5, 5.6_
  - [ ]* 7.3 Write unit tests for `toEnvelope` and `fromEnvelope` in `tests/soap/translator.test.ts`
    - Missing required fields, fault normalisation (SOAP 1.1 and 1.2), nil/absent element handling, XML-escape correctness
    - _Requirements: 5.2, 5.3, 5.4, 5.6, 5.7_
  - [ ] 7.4 Write property test for round-trip identity — Property 1
    - **Property 1: Translator round-trip identity**
    - Generate arbitrary JSON records matching a known `OperationSchema`; assert `fromEnvelope(toEnvelope(args).xml)` deeply equals `args`
    - Exclude NaN, Infinity, −Infinity, −0 from numeric arbitraries
    - Minimum 100 iterations
    - **Validates: Requirements 5.5**
  - [ ] 7.5 Write property test for string preservation and body structure — Property 2
    - **Property 2: Round-trip string preservation and body structure**
    - For any `fc.string()`, assert `fromEnvelope` returns `data.value === s` and the SOAP Body contains exactly one child element
    - Minimum 100 iterations
    - **Validates: Requirements 5.5, 5.7**
  - [ ] 7.6 Write property test for missing required fields — Property 3
    - **Property 3: Missing required fields produce a validation error, not an envelope**
    - For any `OperationSchema` and any input omitting at least one required field, assert `toEnvelope` returns `{ ok: false, error: { type: "validationError" } }` and no XML string is produced
    - Minimum 100 iterations
    - **Validates: Requirements 5.3**
  - [ ] 7.7 Write property test for fault normalisation — Property 4
    - **Property 4: SOAP fault normalisation round-trip**
    - For SOAP 1.1 and 1.2 fault envelopes with arbitrary `faultCode`/`faultString` values, assert `fromEnvelope` returns `FaultError` with matching fields
    - Minimum 100 iterations
    - **Validates: Requirements 5.6**

- [ ] 8. Checkpoint — core library complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Download WSDL fixtures
  - [x] 9.1 Save Calculator WSDL to `fixtures/calculator.wsdl`
    - Fetch from `http://www.dneonline.com/calculator.asmx?WSDL` and save as a static file; no network requests at test time
    - _Requirements: 8.1, 8.5_
  - [x] 9.2 Save CountryInfoService WSDL to `fixtures/countryinfo.wsdl`
    - Fetch from `http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL` and save as a static file; no network requests at test time
    - _Requirements: 8.2, 8.5_

- [ ] 10. Redis registry
  - [ ] 10.1 Implement `lib/registry/index.ts`
    - Import `getEnv()` from `lib/env.ts`; construct `Redis` client from `@upstash/redis` using env vars
    - `upsertService`: SHA-256 hash WSDL URL with `crypto.subtle`; check `wsdl-url:{hash}` key; if exists return existing id; else generate 8-char nanoid (`customAlphabet`, alphanumeric only), `HSET service:{id}`, `EXPIRE 2592000`, `SET wsdl-url:{hash}` with same TTL
    - `getService`: `HGET service:{id}`; deserialise JSON; return `ServiceDefinition | null`
    - On any Redis error → `{ ok: false, error: { code: "REGISTRY_UNAVAILABLE", ... } }`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ]* 10.2 Write unit tests for `upsertService` and `getService` in `tests/registry/index.test.ts`
    - Mock `@upstash/redis`; test upsert (new entry), dedup (existing URL returns same id), TTL set, 503 on Redis connection error
    - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - [ ]* 10.3 Write property test for registry ID format and uniqueness — Property 6
    - **Property 6: Registry ID uniqueness and format**
    - For any sequence of distinct WSDL URLs, assert all generated ids are distinct, 8–12 chars, and match `[A-Za-z0-9]+`
    - Minimum 100 iterations
    - **Validates: Requirements 6.1**
  - [ ]* 10.4 Write property test for registry deduplication — Property 7
    - **Property 7: Registry deduplication (idempotence)**
    - For any WSDL URL, calling `upsertService` twice returns the same id and makes only one Redis write
    - Minimum 100 iterations
    - **Validates: Requirements 6.3**

- [ ] 11. Contract tests for WSDL fixtures
  - [ ] 11.1 Write `tests/soap/contract.test.ts`
    - Load `fixtures/calculator.wsdl` from filesystem; assert `parseWsdl` returns `ServiceDefinition` with operations `Add`, `Subtract`, `Multiply`, `Divide` (exactly, no extras)
    - Load `fixtures/countryinfo.wsdl`; assert operations include `CountryFlag`, `CountryName`, `CapitalCity`, `CountryCurrency` and total deduplicated count ≥ 4
    - Run `generateSchemas` on both fixtures; assert every zod field uses only the supported types (no `z.unknown()`)
    - For a valid input from each fixture's `OperationSchema`, assert the translator round-trip returns a deeply equal object (Property 1 applied to real WSDL data, validates Requirement 8.4)
    - All tests read files via `fs.readFileSync`; no outbound network requests
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 12. Summon API route
  - [ ] 12.1 Implement `app/api/summon/route.ts`
    - Export `runtime = "nodejs"` at module scope
    - Define `SummonRequestSchema = z.object({ wsdlUrl: z.string().url() })`
    - POST handler: parse body → validate schema (400 `INVALID_REQUEST`) → URL length ≤ 2048 (400 `INVALID_REQUEST`) → `fetchWsdl` → `parseWsdl` → `generateSchemas` → `upsertService` → build `mcpUrl` from request origin → return 200 with `{ id, name, operations[0..499], wsdlUrl, mcpUrl, warnings[0..49] }`
    - Map all `LazarusError.code` values to correct HTTP status per design table
    - Wrap entire handler in `try/catch`; log full error server-side; return `{ error: "An unexpected error occurred.", code: "INTERNAL_ERROR" }` with HTTP 500
    - All error responses include `error` (≤ 500 chars, no stack traces/paths) and `code`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 9.1, 9.2, 9.3_
  - [ ]* 12.2 Write unit tests for the API route in `tests/api/summon.test.ts`
    - Mock `fetchWsdl`, `parseWsdl`, `generateSchemas`, `upsertService`
    - Test each HTTP status path: 200, 400 (invalid body, bad URL, URL too long), 400 (SSRF), 422 (parse fail), 422 (too large), 502 (fetch fail), 503 (registry error), 500 (unexpected throw)
    - Assert `error` field ≤ 500 chars and contains no stack-trace patterns on all error responses
    - Assert `warnings` array is present (possibly empty) on 200 responses
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 9.1, 9.2, 9.3_
  - [ ]* 12.3 Write property test for error response safety — Property 10
    - **Property 10: Error responses never exceed 500 characters and contain no stack traces**
    - For any simulated error condition, assert `error` field is ≤ 500 chars, does not contain `"    at "`, `node_modules` path segments, or filesystem path segments with `.ts`/`.js`/`.mjs`/`.cjs` extensions
    - HTTP/HTTPS URLs in the message are permitted
    - Minimum 100 iterations
    - **Validates: Requirements 9.1, 9.2**

- [ ] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. End-to-end tests
  - [ ] 14.1 Write `e2e/summon.spec.ts`
    - POST to `/api/summon` with the Calculator WSDL URL against the running dev server
    - Assert HTTP 200 and response body has `id`, `name`, `operations` (non-empty), `wsdlUrl`, `mcpUrl` matching `/api/mcp/<id>`
    - Assert `mcpUrl` is an absolute HTTPS/HTTP URL on the same host
    - _Requirements: 7.1, 8.1_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests are in the same test files as their unit tests (no separate property-test files)
- Properties 1–10 from the design document each map to a specific test sub-task above
- `lib/soap/translator.ts` is pure (no I/O); all functions are safe to property-test without mocking
- The `soap` npm package must never make autonomous network requests — `safeFetch` is injected as its HTTP resolver and all external XSD schemas are pre-fetched before the WSDL string is handed to the library
- `export const runtime = "nodejs"` in the route is required for Node.js DNS/crypto APIs

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["3.1", "4.1"] },
    { "id": 2, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 3, "tasks": ["4.5", "5.1"] },
    { "id": 4, "tasks": ["5.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.5"] },
    { "id": 6, "tasks": ["7.1", "9.1", "9.2", "10.1"] },
    { "id": 7, "tasks": ["7.2", "10.2", "10.3", "10.4"] },
    { "id": 8, "tasks": ["7.3", "7.4", "7.5", "7.6", "7.7", "11.1"] },
    { "id": 9, "tasks": ["12.1"] },
    { "id": 10, "tasks": ["12.2", "12.3"] },
    { "id": 11, "tasks": ["14.1"] }
  ]
}
```
