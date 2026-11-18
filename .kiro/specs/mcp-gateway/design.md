# Design Document

## Overview

The Gateway is a stateless MCP server created per request from a stored `ServiceDefinition`. All safety logic lives in small pure modules under `lib/safety/`, so it can be property-tested without MCP or Redis. MCP and Redis are thin shells.

```mermaid
flowchart TD
  Agent([MCP client / agent]) -->|tools/call| Route["app/api/mcp/[id]/route.ts"]
  Route --> Server["lib/mcp/server.ts\ncreateServerFor(service)"]
  Server --> Pipe["lib/mcp/pipeline.ts\nrunCall()"]
  Pipe --> V[validate: buildZodSchema]
  V --> P["lib/safety/policy.ts\ndecide()"]
  P -->|allow| X[execute: toEnvelope → safePost → fromEnvelope]
  P -->|hold| A["lib/safety/approvals.ts"]
  P -->|ghost| G["lib/safety/ghost.ts"]
  P -->|block| B[tool error]
  A -->|approved| X
  X --> T["lib/safety/transcript.ts\nredact + append"]
  G --> T
  B --> T
  T --> Agent
  Human([Approver in UI]) -->|approve / deny| API["app/api/services/[id]/approvals/[aid]"]
  API --> A
```

## Dependencies

- `@modelcontextprotocol/sdk` (1.32.2): low-level `Server` and `WebStandardStreamableHTTPServerTransport` (stateless: `sessionIdGenerator: undefined`, `enableJsonResponse: true`).
- Reuses from `summon`: `buildZodSchema`, `toEnvelope` (returns `{ ok, xml, headers }`), `fromEnvelope`, `getService` (returns `{ ok, value }`), and `generateOwnerToken`/`verifyOwnerToken`/`publicDefinition` from `lib/owner-token.ts`.
- New in this spec: `safePost` in `lib/soap/fetcher.ts` (below). `safeFetch` is GET-only and rejects every non-200, so it cannot carry a SOAP call.

## Data models (`lib/safety/types.ts`)

```typescript
import type { Risk } from "../soap/types"; // single definition lives in lib/soap/types.ts; do not redeclare
export type Effect = "allow" | "hold" | "block";
export type CondOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains";

export type Condition = { field: string; op: CondOp; value: string | number | boolean };
export type Rule = {
  id: string; operation: string; // operation name or "*"
  when?: Condition; effect: Effect; reason: string; // reason <= 200 chars
};
export type Decision =
  | { action: "allow" | "hold" | "block" | "ghost"; ruleId?: string; reason: string };

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed";
export type Approval = {
  id: string; serviceId: string; tool: string; args: unknown; // args already redacted? NO: raw args needed to execute; see below
  risk: Risk; reason: string; status: ApprovalStatus;
  createdAt: string; expiresAt: string; resolvedAt?: string; note?: string;
};
export type TranscriptEntry = {
  id: string; ts: string; tool: string; args: unknown; risk: Risk;
  decision: Decision["action"]; ruleId?: string; approvalId?: string;
  outcome: "ok" | "fault" | "error" | "held" | "blocked" | "ghost";
  durationMs: number; soapRequest?: string; soapResponse?: string; summary: string;
};
```

> **Approval args & secrets:** the Approval stores the real arguments (needed to execute) under key `approval:{svc}:{id}`; the UI-facing API returns `redact(args)`. Arguments containing redactable keys are still stored, with the Redis TTL of 900 s, and never logged.

## Modules

### `lib/safety/policy.ts` (pure)

```typescript
export function decide(input: {
  op: OperationSchema; risk: Risk; args: unknown;
  rules: Rule[]; ghost: boolean;
}): Decision;
```

Algorithm:
1. `matching` = rules where `(rule.operation === op.name || rule.operation === "*")` and its condition matches. `evaluate(condition, args)` returns `true`, `false` or `"unknown"` (absent field, type mismatch, unknown operator, rejected path, or a throw). A rule matches when there is no condition, when `evaluate` is `true`, or when it is `"unknown"` and the effect is not `allow` (fail closed: `block` and `hold` match, `allow` does not).
2. If any matching rule has `block` → `{ block, ruleId, reason }`.
3. If `ghost && risk !== "read"` → `{ ghost }`.
4. If any matching rule has `hold` → `{ hold, ruleId }`.
5. If risk is `destructive` and no matching rule with `allow` **that names the operation explicitly** → `{ hold, reason: "Destructive operation" }`.
6. Else `{ allow }`.

`getPath(args, "a.b")` safely walks plain objects (no prototype access: reject segments `__proto__`, `constructor`, `prototype`).

### `lib/safety/redact.ts` (pure)

```typescript
export const SENSITIVE = /pass(word)?|secret|token|api[-_]?key|authorization|credential|ssn/i;
export function redactJson(v: unknown): unknown;     // deep; key-based
export function redactXml(xml: string): string;       // element local-name based, regex over <ns:name>value</ns:name>
export function truncate(s: string, max: number): string;
```

### `lib/safety/approvals.ts`

| Key | Type | TTL |
|---|---|---|
| `approval:{svc}:{id}` | Hash (Approval JSON, `claimed`) | 900 s |
| `approvals:{svc}` | List of ids (LPUSH, LTRIM 0 49) | 30 d |

No global Redis client: the module exports a factory that takes an injected client (same style as `lib/registry/index.ts`).

```typescript
export interface ApprovalsRedis {  // subset of the @upstash/redis client
  hset(key: string, fields: Record<string, string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  lpush(key: string, ...elements: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
}
export function createApprovals(redis: ApprovalsRedis, options?: { now?: () => number }): {
  createApproval(svc: string, a: Omit<Approval,"id"|"status"|"createdAt"|"expiresAt">): Promise<Approval>; // nanoid id (21 chars)
  getApproval(svc: string, id: string): Promise<Approval | null>;   // pending past expiresAt reads "expired"
  resolveApproval(svc: string, id: string, d: "approve"|"deny", note?: string): Promise<"ok"|"not_found"|"conflict">;
  claimExecution(svc: string, id: string): Promise<boolean>;        // true only for the first caller, only when approved and unexpired
  markExecuted(svc: string, id: string): Promise<void>;
  listApprovals(svc: string): Promise<Approval[]>;
};
```

The hash holds `data` (immutable Approval JSON), `status`, `expiresAtMs`, `resolvedAt`, `note`, `claimed`. Three Lua scripts keep every transition atomic:

- `resolveApproval` is a compare-and-set: it sets `status` only when it equals `pending` and the approval has not expired; otherwise `conflict` (`not_found` for an unknown id).
- `claimExecution` runs `HSETNX claimed` inside one script that first checks `status == approved` and not expired, so a concurrent deny cannot interleave. The pipeline then calls `markExecuted` (status `executed`, only if the hash still exists).
- Any Redis error is rethrown as a plain `Error("Approval store unavailable.")` (no upstream text); callers map it to a 503 / tool error and fail closed.

`tests/helpers/fake-approvals-redis.ts` runs a JS translation of each script.

### `lib/safety/ghost.ts` (pure)

`ghostResponse(op: OperationSchema): unknown` builds a deterministic sample object from `outputDescriptor`: strings → `"ghost-<fieldName>"`, ints → 1, decimals/floats/doubles → the number `0`, booleans → true, date → `"2000-01-01"`, dateTime → fixed ISO, arrays → one element, optional → omitted, nillable → null.

### `lib/safety/transcript.ts`

```typescript
export async function appendTranscript(svc: string, e: TranscriptEntry): Promise<void>; // LPUSH + LTRIM 0 199 + EXPIRE 30d
export async function listTranscripts(svc: string, since?: string): Promise<TranscriptEntry[]>;
```

Redaction is applied inside `appendTranscript` (defence in depth), not only by callers.

### `safePost` (added to `lib/soap/fetcher.ts`)

```typescript
export async function safePost(url: string, req: {
  body: string; headers: Record<string, string>; timeoutMs?: number; maxBytes?: number;
}): Promise<{ ok: true; status: number; body: string } | { ok: false; error: LazarusError }>;
```

Shares the SSRF machinery of `safeFetch` (DNS pinning through the custom `lookup`, blocked ranges, IP-literal check, dev loopback flag honoured only outside production) by generalising `requestOnce` to take a method, headers and body. Differences from `safeFetch`: method is always `POST`; request headers are limited to an allowlist (`Content-Type`, `SOAPAction`) plus a fixed `User-Agent`; **redirects are never followed** (any 3xx returns a failure, so a hostile upstream cannot bounce the call to an internal address); every HTTP status is returned to the caller with its body (a SOAP Fault arrives as HTTP 500); request body is capped at 256 KB; default timeout 25 000 ms; response cap 5 MB. The caller must pass the bytes from `toEnvelope` and read the response with `fromEnvelope`, which parses untrusted XML safely.

### `lib/mcp/tools.ts`

```typescript
export type ToolDef = { name: string; op: OperationSchema; port: string; description: string; inputSchema: object; annotations: {...} };
export function buildTools(service: ServiceDefinition): ToolDef[];
export function sanitizeToolName(raw: string, taken: Set<string>): string;
```

`sanitizeToolName` replaces every character outside `[A-Za-z0-9_-]` with `_`, maps an empty result to `op`, caps at 64 characters, resolves collisions with `_2`, `_3`... (truncating the base so the total stays ≤ 64), adds the result to `taken`, and never throws (a non-string input yields `op`).

**Description (untrusted documentation).** WSDL documentation is attacker-controlled text that agents read, so it can carry tool-poisoning instructions. The description is `Risk: <risk> — <riskReason>`, a blank line, then the sanitised documentation (or the operation name if none). Sanitising turns tab/newline-class characters into spaces, strips control and format (zero-width, bidi) characters, collapses whitespace to single spaces, caps at 400 characters with an ellipsis and trims. `riskReason` gets the same treatment capped at 120 characters. The result is at most 1,000 characters. Tool name and Risk line never come from documentation.

Annotations: `openWorldHint: true` always; `readOnlyHint: true` for read; `destructiveHint: true` for destructive; `idempotentHint: false` for write and destructive. Other hints are left unset.

### `lib/mcp/pipeline.ts`

```typescript
export type Deps = {
  registry: Pick<Registry, "getRules" | "getSettings">;
  transcripts: Pick<Transcripts, "appendTranscript">;
  approvals: Approvals;
  post: typeof safePost;
  rateRedis: RateRedis;          // used by hit() for rate limiting
  now: () => number;
  newId: () => string;
};
export function createPipeline(deps: Deps): {
  runCall(ctx: { service: ServiceDefinition; tool: ToolDef; args: unknown; clientIp: string }): Promise<McpToolResult>;
};
```

`Deps` makes the pipeline testable with in-memory fakes. The pipeline never imports Redis, env or global state.

Step order of `runCall`:

1. **Rate limit.** Deliberate deviation from the order in Requirement 3.1: it runs first because it is cheap and protects every step after it.
2. **Rules and settings** from the registry. If either fails, return a tool error and execute nothing (fail closed).
3. **Validate** with `buildZodSchema` (strict). Errors list the field path and message only, never values. Later steps use the parsed value, not the raw arguments.
4. **Decide** with `decide`.
5. **Act:** `block` returns a tool error, `ghost` returns the simulated response, `allow` runs `toEnvelope` → `post` → `fromEnvelope`, `hold` creates an approval (until the approval flow lands, `hold` returns the tool error "Approval flow is not available.").
6. **Transcript**, always, for every outcome. A transcript failure is logged and never changes or fails the call. Summaries use only fixed strings, the operation name and counts, never argument values or upstream text.

The upstream is contacted only in the `allow` branch of step 5.

### `lib/mcp/server.ts`

`createServerFor(service, deps, ctx: { clientIp }): Server` uses the SDK's low-level `Server` (not `McpServer.registerTool`) with request handlers for `tools/list` and `tools/call`. Reasons: (a) `tools/list` returns each `ToolDef.inputSchema` exactly as `buildTools` built it, and (b) argument validation stays in our pipeline and returns tool errors, not SDK protocol errors.

- `tools/list`: one tool per `ToolDef` (name, description, inputSchema, annotations) plus the built-in `check_approval` (`{ approvalId: string }`; annotations `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`).
- `tools/call`: `check_approval` goes to `pipeline.runCheckApproval`; a known tool goes to `pipeline.runCall`; any other name returns the tool error "Unknown tool." and nothing else runs (the upstream is never called, Requirement 3.7). A thrown error becomes a fixed tool error with no message or stack text.
- `buildTools` reserves the name `check_approval` (seeds the taken set), so an operation with that name becomes `check_approval_2`.

`lib/mcp/deps.ts` is the composition root: `defaultDeps()` builds `Deps` lazily on each call (no env or Redis at import time), reusing `getEnv()` and the Upstash client settings used by the registry, through a thin typed adapter (`adaptRedis`) that pins the Upstash methods to `ApprovalsRedis`, `TranscriptRedis` and `RateRedis`.

### `lib/auth/owner.ts`

Thin module. Token generation, hashing and constant-time verification already exist in `lib/owner-token.ts` (`generateOwnerToken`, `hashOwnerToken`, `verifyOwnerToken`, `publicDefinition`); do not reimplement them.

```typescript
export async function authorizeOwner(service: Pick<ServiceDefinition, "ownerTokenHash"> | null | undefined, presented: unknown): Promise<boolean>; // verifyOwnerToken against service.ownerTokenHash; false (never throws) on no/invalid hash or any non-string, empty or oversized token
export function isDemoService(service: Pick<ServiceDefinition, "wsdlUrl"> | null | undefined): boolean;
```

`isDemoService` is true only when the parsed hostname of `service.wsdlUrl` (http/https only) equals the host configured in the optional env var `LAZARUS_GRAVEWOOD_HOST` (`host` or `host:port`, read through `gravewoodHost()` in `lib/env.ts`), compared after lowercasing, AND the parsed URL pathname (dot segments normalised by `new URL`) starts with `/api/gravewood/`. A port is compared (with scheme defaults 80/443) only when the configured value has one. Unset or blank config means no service is a demo service. Look-alikes (`gravewood.evil.com`, `gravewood.app.evil.com`, `gravewood.app@evil.com`, trailing-dot hosts) and invalid URLs return false.

### Routes

- `app/api/mcp/[id]/route.ts`: `POST` creates a transport and server per request, `OPTIONS` for CORS, other methods 405.
- `app/api/services/[id]/route.ts`: GET summary.
- `app/api/services/[id]/rules/route.ts`: PUT.
- `app/api/services/[id]/settings/route.ts`: PATCH.
- `app/api/services/[id]/approvals/route.ts`: GET.
- `app/api/services/[id]/approvals/[aid]/route.ts`: POST.
- `app/api/services/[id]/transcripts/route.ts`: GET.

No route exports `runtime` (rejected by `cacheComponents: true`).

## Correctness Properties

### Property 16: Destructive never runs unattended by default
For any destructive operation, any arguments, and any rule set with no explicit `allow` naming the operation, `decide` never returns `allow`.

### Property 17: Most restrictive rule wins
For any set of matching rules, the decision's strictness (`block > ghost > hold > allow`) is ≥ the strictness of each matching rule's effect, except where ghost mode replaces hold.

### Property 18: Fail closed on bad conditions
For any rule whose condition has a non-numeric value compared with `gt/gte/lt/lte` against any argument, a `block` or `hold` rule is treated as matching. An `allow` rule with an unevaluable condition never matches: the decision equals the decision without that rule, and a destructive operation is never allowed through it.

### Property 19: Redaction removes every sensitive value
For any JSON object containing keys matching `SENSITIVE` at any depth with random string values, `JSON.stringify(redactJson(obj))` contains none of those values.

### Property 20: Ghost never calls upstream
For any service, operation and arguments with `ghost: true` and a non-read risk, the injected fetch fake is called zero times and the result carries `ghost: true`.

### Property 21: Approvals execute at most once
For any number N ≥ 1 of concurrent `check_approval` calls on one approved Approval, exactly one executes upstream (the fetch fake is called once).

### Property 22: Approval executes with stored arguments
For any Approval and any arguments passed to `check_approval`, the arguments sent upstream equal the stored arguments.

### Property 23: Tool names are valid and unique
For any list of operation names (including duplicates, unicode and very long names), `buildTools` yields names matching `^[A-Za-z0-9_-]{1,64}$`, all distinct.

### Property 24: Owner token never leaks
For any sequence of API calls, no response body or transcript entry contains the plaintext token or its hash.

## Deviations from the original design (task 9.2, hold path)

- **Re-deciding at execution.** `executeApproved` (in `lib/mcp/pipeline.ts`, shared with `check_approval` in 9.3) reloads rules and settings (fail closed) and runs `decide` again with the stored arguments. A rule changed to `block`, or ghost mode switched on, after approval wins over the approval: nothing is sent. A fresh `hold` is not asked again; the human already approved this exact call. In that case the approval is still consumed (claimed and marked executed).
- **`claimed` status.** If `claimExecution` returns false, the call returns a non-error result `{ status: "claimed", approvalId }` telling the agent to call `check_approval` again later. The upstream is not called by that caller.
- **Execute once, never retry.** After any successful claim, `markExecuted` runs whether the upstream call succeeded, failed, was blocked or was ghosted. An approved call is attempted at most once and never retried automatically; a retry needs a new call and a new approval.
- **Raw arguments in the Approval.** The parsed (unredacted) arguments are stored because they are what gets executed; the UI-facing API redacts. Requirement 5.1 says "redacted arguments" and should be read as "redacted when shown".
- **Outcomes.** Denied: `blocked`. Expired, approval store failure, vanished approval: `error`. Still pending after 20 s, or `claimed`: `held`. Transcript entries for these carry `approvalId`; summaries are fixed strings.
- **`Deps.sleep`.** The wait uses injected `now` and `sleep` (polling every 500 ms, deadline `now() + 20 000`), so tests run on a fake clock.

## Error Handling

- Domain errors become MCP tool results with `isError: true` and short sentences; internals are logged server-side only (Property 10 from `summon` applies: ≤ 500 chars, no stack traces).
- Redis failure on transcript append never fails the call (log and continue); Redis failure on Approval create returns a tool error and the call is NOT executed (fail closed).

## Testing Strategy

- Unit: policy, redact, ghost, tools, owner (pure, fast).
- Property: 16–24 with fast-check.
- Pipeline tests with in-memory fakes for approvals, transcript, fetch.
- Integration: MCP SDK `Client` against the route handler using the Gravewood bank handler as upstream (no network).
- E2E (Playwright): summon the Gravewood sandbox, call `CloseAccount` through the MCP endpoint with `fetch`, assert it is held, approve through the API, assert the account closed.
