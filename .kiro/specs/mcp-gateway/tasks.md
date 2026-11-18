# Implementation Plan: MCP Gateway

## Overview

Build the pure safety modules first (types, redact, policy, ghost), then storage (approvals, transcripts, owner auth), then the pipeline, then the MCP server and routes. Prerequisites: `summon` tasks 1–14 and its risk addendum are done; `gravewood-bank` is done (used by integration tests). One task at a time, Autopilot off.

## Tasks

- [x] 1. Safety types and zod schemas
  - [x] 1.1 Create `lib/safety/types.ts` (types from the design; import `Risk` from `lib/soap/types`) and `lib/safety/schemas.ts` (zod for `Rule`, `Condition`, settings, approval decision)
    - _Requirements: 4.4, 4.8, 10.2_
  - [x] 1.2 Add `safePost` to `lib/soap/fetcher.ts` (see design: shares SSRF machinery, POST only, header allowlist, no redirects, any status returned, 256 KB request cap, 25 s default)
    - _Requirements: 3.3, 3.5, 3.6_
  - [x] 1.3 Tests in `tests/soap/safepost.test.ts` against a local `node:http` server: body and allowed headers arrive; a disallowed header is dropped; HTTP 500 with an XML body is returned as ok with status 500; a redirect is NOT followed (no second request, failure result); 169.254.169.254, 10.0.0.1 and public-name-resolving-to-private are blocked with zero sockets opened; request over 256 KB rejected before any socket; response over the cap and timeout fail cleanly; production ignores the loopback flag
    - _Requirements: 3.3, 3.5, 3.6_

- [x] 2. Redaction
  - [x] 2.1 Implement `lib/safety/redact.ts` (`redactJson`, `redactXml`, `truncate`)
    - _Requirements: 8.3_
  - [x] 2.2 Unit tests: nested keys, arrays, XML with namespace prefixes, values containing `<`/`&`
  - [x]* 2.3 Property test 19
    - **Property 19**
    - _Requirements: 8.3_

- [x] 3. Policy engine
  - [x] 3.1 Implement `getPath` with prototype-pollution guard and `holds(condition, args)`
    - _Requirements: 4.4, 4.5, 4.6_
  - [x] 3.2 Implement `decide`
    - _Requirements: 4.1, 4.2, 4.3, 4.7, 7.1_
  - [x] 3.3 Unit tests: default by risk, amount threshold hold, block over hold, ghost over hold, explicit allow vs wildcard allow, `__proto__` path
  - [x]* 3.4 Property test 16
    - **Property 16**
  - [x]* 3.5 Property test 17
    - **Property 17**
  - [x]* 3.6 Property test 18
    - **Property 18**

- [x] 4. Ghost responses
  - [x] 4.1 Implement `lib/safety/ghost.ts`
    - _Requirements: 7.2, 7.3_
  - [x] 4.2 Unit test: output validates against the output zod schema rebuilt from the descriptor

- [x] 5. Checkpoint: all tests pass; ask the user if questions arise

- [x] 6. Owner authentication
  - [x] 6.1 Implement `lib/auth/owner.ts` as a thin module (`authorizeOwner`, `isDemoService`); reuse `verifyOwnerToken` from `lib/owner-token.ts`, do not reimplement hashing
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 6.2 Unit tests: hash is stable, verify is constant-time path, wrong token fails, demo detection rejects look-alike hosts (`gravewood.evil.com`)

- [x] 7. Storage
  - [x] 7.1 Implement `lib/safety/approvals.ts` (Lua compare-and-set, `HSETNX` claim)
    - _Requirements: 5.1, 5.6, 5.7, 5.9_
  - [x] 7.2 Implement `lib/safety/transcript.ts`
    - _Requirements: 8.1, 8.2, 8.4_
  - [x] 7.3 Add rules and settings accessors to `lib/registry/index.ts` (stored under separate keys, not by rewriting the service JSON; `RedisLike` gains only what is needed; `getService` keeps returning `{ ok, value }`)
    - _Requirements: 4.8, 10.2, 10.3_
  - [x] 7.4 Provide in-memory fakes in `tests/helpers/` implementing the same interfaces

- [x] 8. Tool generation
  - [x] 8.1 Implement `lib/mcp/tools.ts` (`buildTools`, `sanitizeToolName`)
    - _Requirements: 2.1–2.5_
  - [x]* 8.2 Property test 23
    - **Property 23**

- [x] 9. Call pipeline
  - [x] 9.1 Implement `lib/mcp/pipeline.ts` for validate → decide → allow path → transcript
    - _Requirements: 3.1–3.7_
  - [x] 9.2 Add hold path: create approval, poll up to 20 s, approved/denied/pending results
    - _Requirements: 5.1–5.5, 5.8_
  - [x] 9.3 Add `check_approval` execution with atomic claim
    - _Requirements: 5.6, 5.7, 5.8, 5.9_
  - [x] 9.4 Add ghost and block paths
    - _Requirements: 4.3, 7.1–7.5_
  - [x] 9.5 Add rate limiting
    - _Requirements: 9.1_
  - [x]* 9.6 Property test 20: ghost never calls upstream
    - **Property 20**
  - [ ]* 9.7 Property test 21: approvals execute at most once
    - **Property 21**
  - [ ]* 9.8 Property test 22: stored arguments win
    - **Property 22**

- [x] 10. Checkpoint: pipeline tests pass with fakes; ask the user if questions arise

- [x] 11. MCP server and route
  - [x] 11.1 Implement `lib/mcp/server.ts` (`createServerFor`)
    - _Requirements: 1.5, 2_
  - [x] 11.2 Implement `app/api/mcp/[id]/route.ts` (POST, OPTIONS, 405s, 256 KB cap, `maxDuration` only, no `runtime` export)
    - _Requirements: 1.1–1.4, 1.6, 9.3_
  - [x] 11.3 Integration test with the MCP SDK `Client` against the handler, using the Gravewood handler as upstream
    - _Requirements: 1, 3_

- [x] 12. Management APIs
  - [x] 12.1 `GET /api/services/[id]`
    - _Requirements: 10.1_
  - [x] 12.2 `PUT rules`, `PATCH settings`
    - _Requirements: 10.2, 10.3, 6.2_
  - [x] 12.3 `GET approvals`, `POST approvals/[aid]`
    - _Requirements: 10.4, 10.5, 10.6, 6.3_
  - [x] 12.4 `GET transcripts`
    - _Requirements: 8.5_
  - [x]* 12.5 Property test 24: owner token never leaks
    - **Property 24**
    - _Requirements: 6.4_

- [x] 13. End-to-end
  - [x] 13.1 Playwright: summon Gravewood, `tools/list`, call `GetBalance` (allowed), call `CloseAccount` (held), approve via API, confirm closed; second run with ghost mode confirms the account is unchanged
  - _Requirements: all_

- [x] 14. Final checkpoint
  - Run `npm test` and `npm run e2e`; update `KIRO_LOG.md`
