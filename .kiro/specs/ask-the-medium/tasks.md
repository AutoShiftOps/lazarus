# Implementation Plan: Ask the Medium

## Overview

Build the loop against fakes first (no AWS needed), then the scripted fallback, then Bedrock, then the route and UI. Prerequisites: `mcp-gateway` and `seance-ui` complete. One task at a time, Autopilot off.

## Tasks

- [ ] 1. Types and env
  - [ ] 1.1 `lib/medium/types.ts`; add `BEDROCK_MODEL_ID`, `AWS_REGION`, `MEDIUM_DAILY_CALL_CAP`, `MEDIUM_FORCE_OFFLINE` to `lib/env.ts` (all optional)
    - _Requirements: 2.1, 3.2_

- [ ] 2. Agent loop
  - [ ] 2.1 Implement `lib/medium/loop.ts` with limits, dedupe and held handling
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [ ]* 2.2 Property tests 33, 34
    - **Properties 33, 34**
  - [ ]* 2.3 Property test 35 using the real pipeline with fakes
    - **Property 35**
    - _Requirements: 1.2_
  - [ ]* 2.4 Property test 36
    - **Property 36**
    - _Requirements: 2.3, 2.4_

- [ ] 3. Scripted medium
  - [ ] 3.1 Implement `planFromMessage` and `ScriptedModel`
    - _Requirements: 4.1, 4.2, 4.3_
  - [ ] 3.2 Unit tests for the three example prompts and a nonsense prompt
  - [ ]* 3.3 Property test 37
    - **Property 37**

- [ ] 4. Checkpoint: all tests pass; ask the user if questions arise

- [ ] 5. Budget and rate limits
  - [ ] 5.1 Move `hit` to `lib/rate-limit.ts` (update Gravewood imports); implement `lib/medium/budget.ts`
    - _Requirements: 3.1, 3.2_

- [ ] 6. Bedrock model
  - [ ] 6.1 Implement `lib/medium/bedrock.ts` (Converse + tools, error mapping)
    - _Requirements: 2.1, 2.2, 2.5_
  - [ ] 6.2 Unit tests with a mocked client: tool conversion, throttling → `ModelUnavailable`

- [ ] 7. Route
  - [ ] 7.1 `app/api/medium/[id]/route.ts` with SSE, fallback switching, disconnect handling
    - _Requirements: 1.1, 1.6, 3.3_
  - [ ] 7.2 Route test with fake model; event order and fallback

- [ ] 8. UI
  - [ ] 8.1 `MediumPanel` with examples, steps, held state, cancel, mode label
    - _Requirements: 3.4, 5.1–5.4_

- [ ] 9. End-to-end
  - [ ] 9.1 Playwright with `MEDIUM_FORCE_OFFLINE=1`: type "Close the dormant account 7718", see held, release candle, see closed
  - [ ] 9.2 Manual live Bedrock run; record for the demo video

- [ ] 10. Final checkpoint
  - Run `npm test` and `npm run e2e`; update `KIRO_LOG.md`
