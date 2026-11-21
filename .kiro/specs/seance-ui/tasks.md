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
  - [x] 2.3 `lib/ui/form-model.ts`
    - _Requirements: 4.1, 4.2_
  - [x]* 2.4 Property test 31
    - **Property 31**
  - [x] 2.5 `lib/ui/rule-text.ts` and `lib/ui/token-store.ts`
    - _Requirements: 7.3, 6.11_
  - [x]* 2.6 Property test 32
    - **Property 32**
  - [x] 2.7 `lib/ui/poll.ts`
    - _Requirements: 5.1_

- [ ] 3. Checkpoint: all tests pass; ask the user if questions arise

- [x] 4. Theme foundation
  - [x] 4.1 CSS variables, fonts, base layout, focus ring, reduced-motion rules
    - _Requirements: 8.1, 8.2, 8.4_
  - [x] 4.2 `RiskBadge` (text + icon + colour)
    - _Requirements: 3.2, 3.3_
  - [ ] 4.3 Kiroween atmosphere: graveyard hero art, bats, flickering flame, rising spirits, heartbeat line, Still mode toggle
    - _Requirements: 1.4, 8.7-8.10_
  - [x] 4.4 Awakening ritual: full-screen overlay, pure ritual timing, compact hero
  - [x] 4.5 Ghost pointer follower and wisp cursor
    - Do not touch public/lazarus-logo.svg or .env.local. Do not commit.
    - A. lib/ui/ghost-follow.ts: followStep(current, target, dtMs, lagMs = 140) with alpha = 1 - exp(-dt/lag), dt clamped to 100 ms, no NaN, snap under 0.3 px; facing(vx) returns "left" or "right" with a dead zone. Tests in tests/ui/ghost-follow.test.ts (converges, no overshoot, frame-rate independence, no NaN, dead zone) plus a fast-check property that distance to target never increases.
    - B. components/GhostCursor.tsx (client), mounted once in app/layout.tsx: active only when (pointer: fine) and (hover: hover) match, not reduced motion, and html[data-still] is not "true"; react to all three (media events, MutationObserver) and clean up listeners and rAF. Fixed, pointer-events-none, aria-hidden, z-index below ritual overlay and dialogs, above page content; translate3d only in a single rAF loop that runs only while visible and not at rest, no layout reads. Original ~28 px inline SVG ghost (soft teal, wavy hem, eyes toward pointer, glow, CSS bob on a child element, opacity 0.9), scaleX flip via facing(), offset ~18 px down-right. Hide on documentElement mouseleave and on touch/pen; show on next mouse move. Fade to 0.25 while any [data-holding="true"] exists.
    - C. app/globals.css (end): teal wisp-flame SVG data-URI cursor (max 32x32, hotspot at tip, fallback auto) on body; links/buttons same wisp with fallback pointer; native text cursor for inputs/textarea, not-allowed for [disabled] and [aria-disabled="true"]. Only inside @media (pointer: fine); off for html[data-still="true"] and prefers-reduced-motion.
    - D. tests/ui/ghost-source.test.tsx (jsdom): aria-hidden, pointer-events-none, nothing interactive; not rendered when (pointer: fine) is false; listeners removed on unmount; source check that only transform and opacity are animated. Extend contrast/atmosphere source tests only if they break.
    - Verify: npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 8.8-8.11_
  - [x] 4.6 Fix awakening overlay (portal) and redraw spirit as a realistic ghost
    - Do not touch public/lazarus-logo.svg or .env.local. Keep public APIs of lib/ui/ritual-timing.ts and lib/ui/awakening-state.ts unchanged. Do not commit.
    - Overlay: render AwakeningRitual through createPortal(..., document.body), client only, guard for undefined document, mount after hydration (useSyncExternalStore or effect flag, no hydration mismatch). Cover full viewport (inset-0, h-dvh/w-screen), opaque background, z-index above header and Atmosphere.
    - Test (jsdom): when open the overlay parent is document.body, not inside the form container; body scroll lock restores on close. Update ritual-source.test.ts only if it breaks.
    - Redraw components/SpiritAwakening.tsx (original inline SVG, under 12 KB, no external assets): layers back to front = moon glow, drifting ground mist bands, grave mound with soil cracks and tombstone at bottom, ghost, front mist wisps. Ghost: tall translucent bluish-white robe (55-75% opacity), vertical gradient fading to transparent, tattered hem, long wispy tapering tail, bowed/hooded head with faint face, hollow dark eye sockets with cold teal glow, slightly open mouth, two thin arms reaching up and out in last stage. Static SVG filter (feGaussianBlur + feTurbulence/feDisplacementMap, fixed seed, never animated), faint inner glow and teal/white rim light.
    - Stages (names from awakening-state.ts): fetching = quiet grave, faint light in cracks, cold mist; reading = tombstone runes glow one by one; stirring = soil trembles (tiny translate), pale fingers push through mound, mist thickens; awake = ghost rises in one smooth motion, head lifts, eyes ignite, arms spread, tail trails into mist, slow breathing glow.
    - Animation: transform and opacity only, CSS keyframes; idle float/sway when awake; rise uses clip-path on a non-animated wrapper with ghost translateY animated behind a fixed mask. Reduced motion / Still mode: static state per stage, no keyframes, same layout. Scene aria-hidden; stage text region stays source of truth.
    - Remove leftover flame-with-eyes artwork from this scene; verify no component renders SpiritAwakening outside the overlay (no duplicate on home page).
    - Tests: update tests/ui/awakening-state.test.ts and tests/ui/ritual-source.test.ts only as needed; add source test that SpiritAwakening animates only transform/opacity and has stage classes/attributes for all four stages.
    - Verify: npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 1.4, 1.7_
    - _Requirements: 1.4, 1.7, 1.8_
  - [x] 4.7 Polish awakening scene (SpiritAwakening.tsx and container in AwakeningRitual.tsx only)
    - Do not touch public/lazarus-logo.svg or .env.local. Keep stage names, timing and tests passing. Do not commit.
    - 1. No clipping: svg overflow visible plus viewBox padding so moon glow, mist and halo are never cut off. Verify at 1280x720 and 360x640.
    - 2. Larger scene: svg about min(70vh, 90vw), centred; stage text and Skip button below without scrolling at 1280x720 and 360x640.
    - 3. Redesign ghost face (original, not a mask): remove grey oval face plate and open mouth; deep dark hollow eye sockets inside the hood with cold teal glow, faint shadowed mouth line, soft shading, no outlined face shape.
    - 4. Emerge from grave: tail and lower robe fade into the mound via gradient mask (no visible hem line above mound); front mist layer overlaps lower body. Rise animation stays transform/opacity only.
    - 5. Keep reduced-motion and Still mode static states.
    - Update tests/ui/spirit-awakening-source.test.ts only if a selector changed.
    - Verify: npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 1.4, 1.7_

  - [x] 4.8 Make the awake ghost scary, not cute (SpiritAwakening.tsx and its CSS only)
    - Do not touch public/lazarus-logo.svg or .env.local. Keep stage names, timing, a11y, reduced-motion/Still static states and all tests passing. Do not commit.
    - 1. Proportions: tall and thin (about 1:2.6), narrow shoulders, long stretched hood and face; body tapers into a long torn trailing shroud of uneven ragged strips, not a bell with a zig-zag hem.
    - 2. Asymmetry: head tilted 12 to 15 degrees; one very long thin arm reaching forward and slightly down with five bony curled fingers, the other arm hanging low and limp. No raised-arms pose.
    - 3. Face: no round face plate or small bright dots. Tall narrow dark slit eyes (about 3x taller than wide) with a faint cold teal glow deep inside, slightly different sizes, left eye a little lower; thin dark vertical mouth gap; deep shadow in the hood.
    - 4. Light and colour: desaturated cold grey-blue, lower opacity at the edges, lit from below with a faint cold grave glow and rim light on one side only; darker upper hood; subtle dark vignette; remove the warm halo behind the ghost (keep the pale moon).
    - 5. Motion (transform/opacity only): slow, slightly jerky stepped rise with the long arm unfolding last; idle is a very slow drift, a delayed head tilt of a few degrees over about 6 s, and an occasional stepped opacity dip to 0.55 every 4 to 7 s. No bounce or bob.
    - 6. SVG under about 14 KB, original design, aria-hidden; reduced motion and Still mode show a static version of the same pose. Update spirit-awakening-source.test.ts only if a selector changed.
    - Run npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 1.4, 1.7, 8.7_
  - [x] 4.9 Fix ritual vignette box and let the awake ghost finish rising
    - Do not touch public/lazarus-logo.svg or .env.local. Do not commit. One task at a time.
    - 1. SpiritAwakening.tsx: the vignette is a hard-edged rectangle around the scene (visible dark square on the overlay). Replace it with a soft radial gradient (transparent centre, fading to the overlay background colour at the edges, no visible boundary) or move it to the overlay background in AwakeningRitual.tsx. No rectangle edge may be visible at 1280x720 or 360x640.
    - 2. lib/ui/ritual-timing.ts: the awake hold becomes 3000 ms (reduced motion and Still mode stay 500 ms) so the full rise and the first idle motion can be seen before navigation. Update tests/ui/ritual-timing.test.ts and any test that asserts 1200 ms. Requirement 1.7 is a minimum, so also update its wording to say at least 3 s.
    - 3. Trim the rise animation to about 1600 ms (still stepped, arms last) so the ghost is fully risen well before the hold ends.
    - 4. Keep everything else unchanged. Run npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 1.4, 1.7_
  - [x] 4.10 Use the painted ghost illustration in the awake stage (public/ritual/ghost.png)
    - Do not touch public/lazarus-logo.svg or .env.local. Do not commit. One task at a time.
    - Asset: public/ritual/ghost.png (1664x2496, 2:3 portrait, light figure on a pure black background). Leave the file as is.
    - 1. In SpiritAwakening.tsx (or AwakeningRitual.tsx) replace the hand-drawn vector ghost group of the awake stage with the illustration rendered through next/image (width 832, height 1248, sizes sensible, quality 80, alt="", aria-hidden). Keep the grave, runes, rising hand, moon and mist of the earlier stages. Remove the now-dead vector ghost markup and unused .aw-* ghost CSS.
    - 2. Composite with mix-blend-mode: screen so the black background disappears over the overlay background. Fade the bottom smoke into the grave with a CSS mask-image (linear gradient to transparent) and keep the front mist layer in front of the lower smoke so it looks like the ghost rises out of the mound.
    - 3. Size: height about min(72vh, 120vw) keeping the 2:3 ratio, centred; the stage text and Skip button must stay visible without scrolling at 1280x720 and 360x640.
    - 4. Render the image from the start of the ritual with opacity 0 (preloaded, no layout shift) so it is ready at the awake stage. Use priority/preload.
    - 5. Motion (transform and opacity only): stepped slow rise from below the mound (translateY about 18% to 0, opacity 0 to 1, scale 0.94 to 1) in about 1600 ms; then idle: slow breathing scale 1 to 1.02 over 6 s, a slow horizontal drift of a few px, and an occasional stepped opacity dip to 0.7 every 5 to 7 s. A faint teal eye glow: a small radial-gradient element (screen blend) at the eye position (about 48% across and 20% down the image) pulsing opacity.
    - 6. Reduced motion and Still mode: static final pose, no keyframes. Keep timing from ritual-timing.ts unchanged.
    - 7. Update spirit-awakening-source.test.ts (allowed animation names, uses next/image with the asset, aria-hidden, only transform/opacity); add a test that public/ritual/ghost.png exists.
    - Run npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 1.4, 1.7, 8.7_
- [x] 5. Home page
  - [x] 5.1 `SummonForm` with staged progress and error display
    - _Requirements: 1.1, 1.4, 1.5_
  - [x] 5.2 "Raise the Gravewood Bank demo" button and example links
    - _Requirements: 1.2, 1.3, 1.6_

- [x] 6. Service page
  - [x] 6.1 Server component, `not-found`, metadata
    - _Requirements: 3.1, 3.5, 9.2_
  - [x] 6.2 `SpiritCard` list and `McpConfig`
    - _Requirements: 3.2, 3.4, 3.6_

- [x] 7. Commune form
  - [x] 7.1 `CommuneForm` calling the MCP endpoint
    - _Requirements: 4.1â€“4.4_

  - [x] 7.2 Mark blocked calls with a machine-readable status (pipeline + commune client)
    - Do not touch public/lazarus-logo.svg or .env.local. Do not commit. Backward compatible: same texts, same decisions, same transcript entries.
    - 1. lib/mcp/pipeline.ts: every block outcome (policy block, human denial, refused or expired approval as appropriate) returns isError: true with the same text AND structuredContent { status: "blocked", reason: <same sanitised text> }. Faults and upstream errors never carry status "blocked".
    - 2. Tests in tests/mcp for each block path and for a SOAP fault without the status; update e2e/mcp-gateway.spec.ts or exact-object assertions only where they must change.
    - 3. lib/ui/commune-client.ts maps structuredContent.status === "blocked" to kind "blocked" with that reason (keep the two fixed-text fallbacks); tests include a custom rule reason that now maps to blocked.
    - 4. CommuneForm shows the blocked reason as text with clear blocked styling.
    - Run npm test, npx tsc --noEmit, npm run lint, npm run build; report exact totals; then git checkout -- next-env.d.ts.
    - _Requirements: 4.4_
- [x] 8. Transcript
  - [x] 8.1 `TranscriptPanel` with expandable four-step view and `aria-live`
    - _Requirements: 5.1â€“5.6_

- [x] 9. Inbox and Candle
  - [x] 9.1 `useApprove` hook (single in-flight request, error mapping)
    - _Requirements: 6.5, 6.10_
  - [x] 9.2 `CandleHold` component (pointer + keyboard, reduced-motion text countdown)
    - _Requirements: 6.3, 6.4, 6.6, 6.8, 6.9_
  - [x] 9.3 `Inbox` with deny, note, checkbox alternative, owner-token gating
    - _Requirements: 6.1, 6.2, 6.7, 6.11, 6.12_
  - [x] 9.4 Component tests: early release sends nothing; keyboard repeat ignored; checkbox path; 409 message

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
