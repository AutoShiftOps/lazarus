# Implementation Plan: Seance UI

## Overview

Pure helpers first (testable, no browser), then components, then pages, then end-to-end. Prerequisites: `summon`, `gravewood-bank`, `mcp-gateway` complete. One task at a time, Autopilot off. Consult `.kiro/steering/ui-seance.md` for every component.

Delivery slices (each ends in something demoable): **A** = tasks 1.2, 2.1-2.2, 4, 5, 6 (raise the demo, see spirits; deploy to Vercel after this slice to catch environment problems early); **B** = tasks 2.3-2.7, 7, 8, 9 (commune, transcript, inbox, candle: the demo core); **C** = tasks 10, 11, 13 (ghost, starter rules, metadata, e2e and axe).

## Tasks

- [x] 1. Shared summon function and demo bootstrap
  - [x] 1.1 Extract the summon pipeline from `app/api/summon/route.ts` into `lib/summon/index.ts` (already done in the summon spec: `summonFromBody`)
  - [x] 1.2 Implement `app/api/demo/route.ts` with rate limits
    - _Requirements: 2.1, 2.2, 2.3_

- [ ] 2. Pure UI helpers
  - [x] 2.1 `lib/ui/hold-machine.ts` (state machine)
    - _Requirements: 6.3, 6.4, 6.5, 6.6_
  - [x]* 2.2 Property tests 28, 29, 30
    - **Properties 28, 29, 30**
  - [ ] 2.3 `lib/ui/form-model.ts`
    - _Requirements: 4.1, 4.2_
  - [ ]* 2.4 Property test 31
    - **Property 31**
  - [ ] 2.5 `lib/ui/rule-text.ts` and `lib/ui/token-store.ts`
    - _Requirements: 7.3, 6.11_
  - [ ]* 2.6 Property test 32
    - **Property 32**
  - [ ] 2.7 `lib/ui/poll.ts`
    - _Requirements: 5.1_

- [ ] 3. Checkpoint: all tests pass; ask the user if questions arise

- [ ] 4. Theme foundation
  - [ ] 4.1 CSS variables, fonts, base layout, focus ring, reduced-motion rules
    - _Requirements: 8.1, 8.2, 8.4_
  - [ ] 4.2 `RiskBadge` (text + icon + colour)
    - _Requirements: 3.2, 3.3_

- [ ] 5. Home page
  - [ ] 5.1 `SummonForm` with staged progress and error display
    - _Requirements: 1.1, 1.4, 1.5_
  - [ ] 5.2 "Raise the Gravewood Bank demo" button and example links
    - _Requirements: 1.2, 1.3, 1.6_

- [ ] 6. Service page
  - [ ] 6.1 Server component, `not-found`, metadata
    - _Requirements: 3.1, 3.5, 9.2_
  - [ ] 6.2 `SpiritCard` list and `McpConfig`
    - _Requirements: 3.2, 3.4, 3.6_

- [ ] 7. Commune form
  - [ ] 7.1 `CommuneForm` calling the MCP endpoint
    - _Requirements: 4.1–4.4_

- [ ] 8. Transcript
  - [ ] 8.1 `TranscriptPanel` with expandable four-step view and `aria-live`
    - _Requirements: 5.1–5.6_

- [ ] 9. Inbox and Candle
  - [ ] 9.1 `useApprove` hook (single in-flight request, error mapping)
    - _Requirements: 6.5, 6.10_
  - [ ] 9.2 `CandleHold` component (pointer + keyboard, reduced-motion text countdown)
    - _Requirements: 6.3, 6.4, 6.6, 6.8, 6.9_
  - [ ] 9.3 `Inbox` with deny, note, checkbox alternative, owner-token gating
    - _Requirements: 6.1, 6.2, 6.7, 6.11, 6.12_
  - [ ] 9.4 Component tests: early release sends nothing; keyboard repeat ignored; checkbox path; 409 message

- [ ] 10. Rules and ghost mode
  - [ ] 10.1 `GhostSwitch` and banner
    - _Requirements: 7.1, 7.2_
  - [ ] 10.2 `RulesPanel`: plain-English list, one-click starter rules, read-only state
    - _Requirements: 7.3, 7.6, 7.7_
  - [ ]* 10.3 (stretch) Add-rule form with destructive-allow warning and confirm checkbox
    - _Requirements: 7.4, 7.5_

- [ ] 11. Metadata and assets
  - [ ] 11.1 Open Graph/Twitter metadata using the thumbnail in `public/`
    - _Requirements: 9.1_

- [ ] 12. Checkpoint: all tests pass; ask the user if questions arise

- [ ] 13. End-to-end and accessibility
  - [ ] 13.1 Playwright: full demo flow (call `CloseAccount`, see held, hold candle 2.2 s, see closed)
  - [ ] 13.2 Playwright: 1 s hold releases nothing
  - [ ] 13.3 Playwright: `axe` on Home and Service pages, zero serious/critical
    - _Requirements: 8.5_
  - [ ] 13.4 Playwright: 360 px viewport, no horizontal scroll
    - _Requirements: 3.6_

- [ ] 14. Final checkpoint
  - Run `npm test` and `npm run e2e`; update `KIRO_LOG.md`; screenshot each page for the Devpost write-up
