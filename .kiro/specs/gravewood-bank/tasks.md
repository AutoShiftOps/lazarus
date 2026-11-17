# Implementation Plan: Gravewood Bank

## Overview

Build the fake SOAP bank bottom-up: money, seed, XML helpers, pure handler, WSDL, store, routes, then the contract test against the real Lazarus pipeline. Run tests after each task. Do one task at a time (Autopilot off).

## Tasks

- [x] 1. Dependencies and types
  - Add `fast-xml-parser` to `dependencies`
  - Create `lib/gravewood/types.ts` (types only)
  - _Requirements: 3, 4_

- [x] 2. Money helpers
  - [x] 2.1 Implement `lib/gravewood/money.ts` (`parseAmountToCents`, `formatCents`)
    - _Requirements: 4.1, 4.2, 4.6_
  - [x] 2.2 Unit tests for edge cases (`"0"`, `"-1"`, `"1.234"`, `"1e3"`, `" 5"`, `"00012.50"`)
  - [x]* 2.3 Property test 13: amount parsing round-trip
    - **Property 13**
    - _Requirements: 4.1, 4.2_

- [x] 3. Seed data
  - [x] 3.1 Implement `lib/gravewood/seed.ts` with the four accounts and 6 fixed transactions each
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 3.2 Unit test: sum of seed balances is 63650.00; all timestamps are fixed strings

- [x] 4. XML helpers
  - [x] 4.1 Implement `lib/gravewood/xml.ts` (parse envelope, build envelope, build fault)
    - Reject `<!DOCTYPE`; entity processing off
    - _Requirements: 5.1, 5.4, 6.2_
  - [x] 4.2 Unit tests: DOCTYPE rejected, billion-laughs sample rejected, namespace prefixes (`soap:`, `s:`, `env:`) all accepted

- [x] 5. Pure handler
  - [x] 5.1 Implement read operations: `ListAccounts`, `GetBalance`, `GetStatement`
    - _Requirements: 3b.1, 3b.2, 3b.3_
  - [x] 5.2 Implement `TransferFunds` with all fault cases
    - _Requirements: 3b.4, 4.2, 4.3, 4.5_
  - [x] 5.3 Implement `UpdateAddress` and `CloseAccount`
    - _Requirements: 3b.5, 3b.6, 3b.7_
  - [x] 5.4 Implement dispatch, SOAPAction check, unknown-operation fault
    - _Requirements: 5.1, 5.2, 5.5, 5.6_
  - [x]* 5.5 Property test 11: transfers conserve money
    - **Property 11**
  - [x]* 5.6 Property test 12: failed operations change nothing
    - **Property 12**
  - [x]* 5.7 Property test 15: faults leak nothing
    - **Property 15**
    - _Requirements: 5.3_

- [x] 6. Checkpoint: all tests pass; ask the user if questions arise

- [x] 7. WSDL
  - [x] 7.1 Implement `lib/gravewood/wsdl.ts`
    - Include documentation text per Req 1.4 and the schema features of Req 1.6
    - _Requirements: 1.1–1.6, 1.8_
  - [x] 7.2 Save the output as `fixtures/gravewood.wsdl` and add a test that the live output equals the fixture (endpoint substituted)

- [x] 8. Store
  - [x] 8.1 Implement `lib/gravewood/store.ts` with optimistic versioning and rate limiting
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 6.3_
  - [x]* 8.2 Property test 14: sandbox isolation (in-memory fake)
    - **Property 14**

- [x] 9. Routes
  - [x] 9.1 `POST /api/gravewood/sandboxes`
    - _Requirements: 2.1, 2.3_
  - [x] 9.2 `GET /api/gravewood/[id]/wsdl`
    - _Requirements: 1.1, 1.5, 1.7_
  - [x] 9.3 `POST /api/gravewood/[id]` (SOAP) with size cap and method checks
    - _Requirements: 5.1, 6.1, 6.3, 6.4, 6.5_
  - [x] 9.4 `POST /api/gravewood/[id]/reset`
    - _Requirements: 2.4_

- [ ] 10. Dev loopback override
  - [ ] 10.1 Add `LAZARUS_DEV_ALLOW_LOOPBACK` to `lib/env.ts`, honoured by `safeFetch` only when not in production
  - [ ] 10.2 Test: production ignores the flag
    - _Requirements: 7.3_

- [ ] 11. Contract test against the real Lazarus pipeline
  - [ ] 11.1 `tests/gravewood/contract.test.ts`: parse `fixtures/gravewood.wsdl` with zero warnings, round-trip every operation through translator and handler
    - _Requirements: 7.1, 7.2_

- [ ] 12. Playwright smoke test
  - [ ] 12.1 `e2e/gravewood.spec.ts`: create sandbox, fetch WSDL, call `GetBalance`
  - _Requirements: 1, 2_

- [ ] 13. Final checkpoint
  - Run `npm test` and `npm run e2e`; update `KIRO_LOG.md` with one line per notable Kiro moment
