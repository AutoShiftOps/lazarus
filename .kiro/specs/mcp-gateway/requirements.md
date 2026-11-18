# Requirements Document

## Introduction

The "mcp-gateway" feature serves each summoned service as a live MCP server at `/api/mcp/{id}` and puts a safety layer between the agent and the legacy system. Every SOAP operation becomes an MCP tool. Before any call reaches the real service, the Gateway decides to **allow**, **hold for human approval**, **block**, or **ghost** (simulate) it, using the operation's risk class, argument-aware rules, and the service's mode. Every decision and call is written to a redacted transcript.

This spec depends on `summon` (ServiceDefinition, Translator, safeFetch, Registry) and its risk addendum (`risk`, `riskReason` on each OperationSchema).

---

## Glossary

- **Gateway**: The MCP endpoint at `app/api/mcp/[id]/route.ts` plus `lib/mcp/`.
- **Tool**: An MCP tool generated from one OperationSchema.
- **Risk**: `"read" | "write" | "destructive"` as assigned by the summon risk classifier.
- **Rule**: A stored policy entry `{ id, operation, when?, effect, reason }` where effect is `allow`, `hold` or `block`.
- **Policy_Engine**: `lib/safety/policy.ts`; decides what happens to a call.
- **Decision**: `{ action: "allow" | "hold" | "block" | "ghost", ruleId?, reason }`.
- **Hold**: A call paused until a human approves or denies it.
- **Approval**: A record `{ id, serviceId, tool, args, risk, reason, status }` with status `pending | approved | denied | expired | executed`.
- **Ghost_Mode**: A per-service setting under which write and destructive calls are simulated and never sent upstream.
- **Transcript**: The ordered log of calls for a service ("Ouija transcript").
- **Owner_Token**: A secret returned once at summon time, authorising changes to a service's rules, mode and approvals.
- **Demo_Service**: A service whose WSDL URL host equals the configured Gravewood host (`LAZARUS_GRAVEWOOD_HOST`) AND whose path starts with `/api/gravewood/`; its approvals are public.

---

## Requirements

### Requirement 1: Serve a service as an MCP server

**User Story:** As an agent builder, I want to point any MCP client at one URL so that all of a service's operations appear as tools.

#### Acceptance Criteria

1. THE Gateway SHALL implement MCP Streamable HTTP in stateless mode at `POST /api/mcp/{id}`, responding with JSON (not SSE) for each request.
2. THE Gateway SHALL respond to `GET` and `DELETE` on that path with HTTP 405.
3. THE Gateway SHALL respond to `OPTIONS` with CORS headers permitting any origin, `POST` and the MCP headers.
4. IF the service id does not exist THEN THE Gateway SHALL return a JSON-RPC error with HTTP 404.
5. WHEN `tools/list` is called, THE Gateway SHALL return one Tool per operation across all ports, plus the built-in tool `check_approval`.
6. THE Gateway SHALL declare a `maxDuration` of 60 seconds and SHALL NOT export `runtime` (rejected by `cacheComponents`).

---

### Requirement 2: Tool generation

**User Story:** As an agent, I want clear tool names and descriptions so that I choose the right operation.

#### Acceptance Criteria

1. THE Gateway SHALL name each tool after its operation, restricted to `[A-Za-z0-9_-]`, at most 64 characters, and unique within the service (a numeric suffix resolves collisions).
2. THE Gateway SHALL build each tool's `inputSchema` from the OperationSchema's `inputDescriptor` via `buildZodSchema` and `z.toJSONSchema`.
3. THE Gateway SHALL treat WSDL documentation as untrusted text (tool-poisoning risk). Each tool description SHALL start with the Gateway's own line `Risk: <risk> — <riskReason>`, then a blank line, then the sanitised documentation (or the operation name when there is none). Sanitising SHALL strip control, zero-width and bidi characters, collapse all whitespace (including newlines) to single spaces, cap the text at 400 characters with an ellipsis, and trim. The tool name and the Risk line SHALL never derive from documentation.
4. THE Gateway SHALL set MCP annotations: `readOnlyHint: true` for read, `destructiveHint: true` for destructive, `idempotentHint: false` for write and destructive.
5. THE whole tool description (Risk line, blank line and documentation) SHALL be at most 1,000 characters.

---

### Requirement 3: Call pipeline

**User Story:** As an integration owner, I want every call to pass through the same checkpoints in the same order.

#### Acceptance Criteria

1. WHEN `tools/call` is received, THE Gateway SHALL execute, in order: validate arguments, redact for logging, decide via Policy_Engine, act on the Decision, write the Transcript entry, return the result.
2. IF arguments fail validation THEN THE Gateway SHALL return an MCP tool error that lists the missing or invalid fields, and SHALL NOT build an envelope or contact the service.
3. WHEN the Decision is `allow`, THE Gateway SHALL translate with `toEnvelope`, call the service through `safePost`, and translate the response with `fromEnvelope`.
4. IF the service returns a SOAP Fault THEN THE Gateway SHALL return an MCP tool error whose text is the fault string (max 300 chars), without stack traces or raw XML.
5. THE Gateway SHALL bound each upstream call to 25 seconds.
6. IF the upstream is unreachable THEN THE Gateway SHALL return a tool error "The spirit did not answer." and log the cause server-side only.
7. THE Gateway SHALL NOT call the upstream service for any request other than `tools/call` of a service tool.

---

### Requirement 4: Risk and policy

**User Story:** As a risk owner, I want dangerous operations stopped by default and rules that look at the arguments.

#### Acceptance Criteria

1. IF no Rule matches a call THEN THE Policy_Engine SHALL decide by risk: `read` → allow, `write` → allow, `destructive` → hold.
2. THE Policy_Engine SHALL evaluate every Rule whose `operation` equals the tool's operation or `"*"` and whose `when` condition is satisfied or absent.
3. WHEN several Rules match, THE Policy_Engine SHALL apply the most restrictive effect (`block` over `hold` over `allow`).
4. A condition SHALL be `{ field, op, value }` where `field` is a dot-path into the arguments (for example `amount` or `transfer.amount`) and `op` is one of `gt gte lt lte eq neq contains`.
5. FOR numeric operators, THE Policy_Engine SHALL compare values parsed as finite numbers; IF either side is not a finite number THEN the condition SHALL be unevaluable (see 4.6).
6. IF a Rule's condition is unevaluable (unknown operator, malformed or forbidden path, absent field, type mismatch, or evaluation throws) THEN THE Policy_Engine SHALL treat a `block` or `hold` Rule as matching and take its effect (fail closed), and SHALL treat an `allow` Rule as not matching.
7. A Rule with effect `allow` SHALL NOT downgrade a `destructive` default hold unless it names that operation explicitly and its condition evaluates to satisfied; an unevaluable condition never downgrades it.
8. THE Gateway SHALL store Rules per service in the Registry, at most 25 Rules per service.

---

### Requirement 5: Hold and approval

**User Story:** As a human approver, I want to see exactly what an agent wants to do and release or refuse it.

#### Acceptance Criteria

1. WHEN the Decision is `hold`, THE Gateway SHALL create an Approval with status `pending`, a 15-minute expiry, the tool name, the redacted arguments, the risk and the reason.
2. WHEN a Hold is created, THE Gateway SHALL wait up to 20 seconds, polling every 500 ms, for the Approval to leave `pending`.
3. IF the Approval is approved within the wait THEN THE Gateway SHALL execute the call exactly as for `allow` and return the real result.
4. IF the Approval is denied within the wait THEN THE Gateway SHALL return a tool error "A human refused this call." with the optional denial note.
5. IF the wait ends with the Approval still pending THEN THE Gateway SHALL return a non-error result with structured content `{ status: "held", approvalId, expiresAt }` and text telling the agent to call `check_approval`.
6. WHEN `check_approval` is called with an approval id of this service, THE Gateway SHALL return `pending`, `denied`, `expired`, or — if `approved` and not yet executed — execute the call once and return its result.
7. THE Gateway SHALL guarantee that an Approval executes at most once, even under concurrent `check_approval` calls (atomic claim).
8. THE Gateway SHALL execute an approved call with the arguments stored in the Approval, never with arguments supplied to `check_approval`.
9. WHEN an Approval passes its expiry, its status SHALL read as `expired` and it SHALL never execute.

---

### Requirement 6: Who may approve

**User Story:** As the service owner, I want only me to change policy, while demo visitors can still approve their own sandbox.

#### Acceptance Criteria

1. THE summon API SHALL return an `ownerToken` once on creation; THE Registry SHALL store only its SHA-256 hash.
2. THE endpoints that resolve Approvals, change Rules, or change settings SHALL require header `x-lazarus-owner: <ownerToken>` and compare hashes in constant time.
3. FOR a Demo_Service, THE Gateway SHALL allow resolving Approvals without the token, but SHALL still require the token to change Rules or settings.
4. THE Gateway SHALL never place an Owner_Token in a Transcript, log, error or response other than the one-time summon response.
5. (Hardening beyond Requirement 10.4.) FOR a service that is not a Demo_Service, `GET /api/services/{id}/approvals` SHALL also require the owner token, with the same HTTP 401 for a missing, malformed or wrong token; for a Demo_Service it SHALL stay public. Approval arguments are always returned redacted, for every caller.

---

### Requirement 7: Ghost mode

**User Story:** As an integration owner, I want to let an agent "try" dangerous operations with no consequences while I watch.

#### Acceptance Criteria

1. WHERE Ghost_Mode is enabled for a service, THE Policy_Engine SHALL return `ghost` for every `write` and `destructive` call that is not blocked.
2. WHEN the Decision is `ghost`, THE Gateway SHALL generate a plausible response from the operation's `outputDescriptor` and SHALL NOT contact the upstream service.
3. THE ghost response SHALL be marked: structured content includes `ghost: true`, and the text begins "[GHOST — nothing was sent to the real service]".
4. THE Gateway SHALL record ghost calls in the Transcript with decision `ghost`.
5. `read` calls SHALL pass through to the real service even in Ghost_Mode.

---

### Requirement 8: Transcripts and redaction

**User Story:** As an auditor, I want a faithful record that never contains secrets.

#### Acceptance Criteria

1. THE Gateway SHALL append a Transcript entry for every `tools/call`, including blocked, held, ghost, failed and validation-error outcomes.
2. EACH entry SHALL contain: id, timestamp, tool, redacted arguments, risk, decision, ruleId (if any), approvalId (if any), duration, outcome (`ok | fault | error | held | blocked | ghost`), the redacted SOAP request and response XML (each truncated to 8 KB), and the result summary.
3. THE Gateway SHALL redact any JSON key or XML element whose local name matches `/pass(word)?|secret|token|api[-_]?key|authorization|credential|ssn/i`, replacing its value with `[redacted]`, before storing or returning it.
4. THE Registry SHALL keep the latest 200 entries per service, expiring after 30 days.
5. THE Gateway SHALL expose `GET /api/services/{id}/transcripts?since=<ISO>` returning entries newest first, capped at 100.
6. THE `since` parameter SHALL be exclusive: only entries strictly newer than it are returned. IF `since` is present but is not a valid ISO 8601 date THEN THE Gateway SHALL return HTTP 400 with a fixed message. FOR a Demo_Service the endpoint SHALL be public; FOR any other service it SHALL require the owner token, with the same HTTP 401 for a missing, malformed or wrong token. Entries SHALL be redacted again when read.

---

### Requirement 9: Abuse protection

**User Story:** As the host, I want a public endpoint that can't be used to hammer a third party.

#### Acceptance Criteria

1. THE Gateway SHALL allow at most 30 `tools/call` per minute per service and 10 per minute per client IP per service; IF exceeded THEN it SHALL return a tool error with "Too many calls" and log the entry as `blocked`.
2. ALL upstream traffic SHALL use `safeFetch`; THE Gateway SHALL contain no other outbound HTTP call.
3. THE Gateway SHALL cap request bodies at 256 KB.
4. THE Gateway SHALL never log or return the raw upstream endpoint's internal IP address.

---

### Requirement 10: Settings and rule APIs

**User Story:** As the UI, I want simple endpoints to read and change policy.

#### Acceptance Criteria

1. `GET /api/services/{id}` SHALL return the ServiceDefinition summary (`id`, `name`, `isDemo`), mode (`ghost` boolean), Rules and, per operation, `name`, `port`, `risk`, `riskReason` and `riskSource`, and never the Owner_Token hash. An unknown or malformed id SHALL return HTTP 404 (a malformed id without touching storage); a storage failure SHALL return HTTP 503 with a fixed message. Every error body SHALL be `{ error, code }`.
2. `PUT /api/services/{id}/rules` SHALL replace the Rules (owner token required; the body is the bare JSON array of rules, at most 25, unique ids, body at most 32 KB) after validating with zod, and return the saved Rules. Invalid Rules SHALL return HTTP 400 with field errors in the message (at most 500 characters); an oversized body SHALL return HTTP 413; a missing, malformed or wrong owner token SHALL return the same HTTP 401.
3. `PATCH /api/services/{id}/settings` SHALL toggle `ghost` (owner token required; the body is exactly `{ ghost: boolean }`, extra keys or a non-boolean SHALL return HTTP 400, body at most 4 KB, otherwise HTTP 413) and return the saved settings. Both write endpoints check, in order: id validity (404, no storage call), service lookup (404 or 503), owner token (401), then the body.
4. `GET /api/services/{id}/approvals` SHALL list pending and recent Approvals (newest first, max 50).
5. `POST /api/services/{id}/approvals/{approvalId}` SHALL accept `{ decision: "approve" | "deny", note?: string (max 200) }`, subject to Requirement 6.
6. RESOLVING an Approval that is not `pending` SHALL return HTTP 409.
7. `GET /api/services/{id}/approvals` SHALL return each Approval with its arguments passed through the redaction of Requirement 8.3; the raw arguments SHALL never leave the server. For a service that is not a Demo_Service it requires the owner token (Requirement 6.5); for a Demo_Service it is public.
8. `POST /api/services/{id}/approvals/{approvalId}` SHALL validate the approval id against `/^[A-Za-z0-9_-]{1,64}$/` (invalid: HTTP 404, no storage call), reject extra body keys, a decision other than `approve`/`deny` or a note over 200 characters with HTTP 400, cap the body at 4 KB (HTTP 413), sanitise the note, and return the updated Approval (redacted arguments) with HTTP 200. An unknown approval returns HTTP 404; a missing, malformed or wrong owner token on a non-demo service returns the same HTTP 401 (Requirement 6.3 exempts demo services).
9. `POST /api/services/{id}/approvals/{approvalId}` SHALL allow at most 30 requests per minute per client IP per service; IF exceeded THEN it SHALL return HTTP 429, and IF the rate limiter is unavailable THEN it SHALL fail closed with HTTP 503 and resolve nothing. A 409 body is `{ error: "This approval is no longer pending.", code: "CONFLICT" }`; a 429 body carries code `RATE_LIMITED`.
