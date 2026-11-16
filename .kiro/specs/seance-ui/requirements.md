# Requirements Document

## Introduction

The "seance-ui" feature is everything a visitor sees: the home page with a one-click demo, the service page where spirits (operations) are listed with their danger level, the commune form, the live Ouija transcript, the rules and ghost-mode controls, and the **approval inbox** where a human releases a held call by **pressing and holding a candle**. The theme is spooky, but every element must explain what is happening. Follows `.kiro/steering/ui-seance.md`.

Depends on: `summon`, `gravewood-bank`, `mcp-gateway` (APIs only; this spec adds no server logic except the demo bootstrap route).

---

## Glossary

- **Home_Page**: `app/page.tsx`.
- **Service_Page**: `app/s/[id]/page.tsx`.
- **Spirit_Card**: UI card for one operation, showing risk.
- **Commune_Form**: A form generated from an operation's `inputDescriptor` to call it from the UI.
- **Transcript_Panel**: Live list of transcript entries.
- **Inbox**: The panel listing pending Approvals.
- **Candle_Hold**: The press-and-hold control that releases an Approval.
- **Risk_Badge**: Visual label: `read` = "Calm" (spectral blue-green), `write` = "Restless" (amber), `destructive` = "Vengeful" (blood red `#c0392b` family on dark, AA contrast).
- **Demo_Bootstrap**: `POST /api/demo` which creates a Gravewood sandbox, summons it, and returns `{ serviceId, ownerToken }`.
- **Token_Store**: Browser `localStorage` key `lazarus:owner:{serviceId}` holding the Owner_Token, with try/catch around every access.

---

## Requirements

### Requirement 1: Home page and demo in one click

**User Story:** As a judge, I want to see Lazarus working within 30 seconds without configuring anything.

#### Acceptance Criteria

1. THE Home_Page SHALL show the product line "Dead SOAP services, reborn as MCP tools — safely." and a WSDL URL input with a "Summon" button.
2. THE Home_Page SHALL show a prominent button "Raise the Gravewood Bank demo".
3. WHEN the demo button is pressed, THE UI SHALL call Demo_Bootstrap, store the Owner_Token in the Token_Store, and navigate to the Service_Page.
4. WHILE summoning, THE Home_Page SHALL show a progress state that names the stage (fetching, reading the runes, raising spirits) and SHALL disable the button.
5. IF summoning fails THEN THE Home_Page SHALL show the API's error message in plain language and keep the input value.
6. THE Home_Page SHALL list the two public demo WSDLs (Calculator, CountryInfo) as clickable examples that fill the input.

---

### Requirement 2: Demo bootstrap

**User Story:** As a judge, I want my own safe sandbox created for me.

#### Acceptance Criteria

1. WHEN `POST /api/demo` is called, THE server SHALL create a Gravewood sandbox, summon its WSDL through the normal summon pipeline, and return `{ serviceId, ownerToken, sandboxId }`.
2. THE endpoint SHALL be limited to 10 requests per minute per IP and a global cap of 500 sandboxes per hour; IF exceeded THEN it SHALL return HTTP 429 with a friendly message.
3. THE endpoint SHALL accept no input and SHALL not fetch any URL other than the app's own sandbox WSDL.

---

### Requirement 3: Service page and spirits

**User Story:** As an integration owner, I want to see every operation and how dangerous it is.

#### Acceptance Criteria

1. THE Service_Page SHALL show the service name, the number of operations, and the MCP endpoint URL with a "Copy" button.
2. THE Service_Page SHALL show one Spirit_Card per operation with its name, one-line description (documentation, max 140 chars, ellipsised), and Risk_Badge with the `riskReason` as tooltip and as visible text on focus.
3. Risk SHALL be conveyed by text and icon as well as colour.
4. THE Service_Page SHALL show a copy-ready MCP client config snippet (JSON) for the endpoint.
5. IF the service id does not exist THEN THE Service_Page SHALL show a "This spirit has passed on" page with a link home, and HTTP 404.
6. THE Service_Page SHALL be usable at 360 px width without horizontal scrolling.

---

### Requirement 4: Commune form

**User Story:** As a user, I want to try an operation from the browser.

#### Acceptance Criteria

1. THE Commune_Form SHALL render one input per top-level field of the operation's `inputDescriptor`, typed by `xsdType` (text, number, checkbox, `datetime-local`), nested complex types as grouped fields, and repeating fields as add/remove lists.
2. THE Commune_Form SHALL mark required fields and validate on submit with the same zod schema used by the Gateway, showing errors next to the field.
3. WHEN submitted, THE Commune_Form SHALL call the service through the same MCP endpoint as an agent would (JSON-RPC `tools/call`), so it is subject to the same safety rules.
4. THE Commune_Form SHALL show the result as formatted JSON, or the decision (held / blocked / ghost) as a clear message with a link to the Inbox or Transcript.

---

### Requirement 5: Ouija transcript

**User Story:** As a viewer, I want to watch calls happen and see exactly what went to the legacy system.

#### Acceptance Criteria

1. THE Transcript_Panel SHALL poll `GET /api/services/{id}/transcripts` every 2 seconds while the tab is visible and stop while hidden.
2. EACH entry SHALL show time, tool, decision (Allowed, Held, Blocked, Ghost), outcome and duration, and SHALL expand to show four steps: JSON in → SOAP request → SOAP response → JSON out.
3. THE Transcript_Panel SHALL show decisions with text labels and icons, not colour alone.
4. THE Transcript_Panel SHALL show `[redacted]` values exactly as returned and SHALL never attempt to reveal them.
5. WHEN no entries exist, THE panel SHALL show "No one has called this spirit yet."
6. NEW entries SHALL be announced to screen readers through an `aria-live="polite"` region, at most one announcement per poll.

---

### Requirement 6: Inbox and Candle Hold

**User Story:** As an approver, I want to see what an agent is trying to do and release it deliberately.

#### Acceptance Criteria

1. THE Inbox SHALL poll pending Approvals every 2 seconds and show for each: tool name, Risk_Badge, the reason it was held, the redacted arguments in a readable table, and time remaining.
2. THE Inbox SHALL provide a "Deny" button that resolves with `deny` on a single click and an optional note (max 200 chars).
3. THE Candle_Hold SHALL release an Approval only after the pointer or touch is held on the candle for 2000 ms without leaving it.
4. WHILE held, THE Candle_Hold SHALL show a progress ring (CSS, no JS animation frames required) and the flame SHALL grow; releasing early SHALL cancel and reset with no request sent.
5. WHEN the 2000 ms completes, THE Candle_Hold SHALL send `approve` exactly once, then show "Released" and disable itself.
6. THE Candle_Hold SHALL be operable by keyboard: holding Space or Enter for 2000 ms releases; releasing the key early cancels; auto-repeat key events SHALL NOT restart the timer.
7. THE Inbox SHALL offer a non-timed alternative for users who cannot hold: a checkbox "I have read the arguments and approve this call" plus an "Approve" button, enabled only after the checkbox is ticked.
8. WHERE `prefers-reduced-motion` is set, THE Candle_Hold SHALL replace flame animation with a text countdown ("Hold… 1.5 s") while keeping the 2000 ms requirement.
9. THE Candle_Hold SHALL prevent the context menu and text selection on touch devices.
10. IF the request fails (409, 403, network) THEN THE Inbox SHALL show a clear message and re-enable the control; for 409 it SHALL say the call was already resolved.
11. FOR a non-demo service, THE Inbox SHALL send the Owner_Token from the Token_Store; IF absent THEN it SHALL show "Only the owner can release calls" and hide the approve controls.
12. FOR `read` and `write` risk Approvals triggered by amount rules, THE Candle_Hold SHALL still require the full 2000 ms.

---

### Requirement 7: Rules and ghost mode

**User Story:** As the owner, I want simple controls for the safety policy.

#### Acceptance Criteria

1. THE Service_Page SHALL show a "Ghost mode" switch with the explanation "Dangerous calls are rehearsed, never sent." The switch SHALL require the Owner_Token and send `PATCH settings`.
2. WHEN Ghost_Mode is on, THE page SHALL show a persistent banner "Ghost mode: nothing dangerous reaches the real service."
3. THE Rules panel SHALL list current Rules in plain English (for example "Hold TransferFunds when amount is greater than 1000").
4. THE Rules panel SHALL provide an "Add rule" form with: operation (dropdown of operations or "any"), optional condition (field dropdown from the operation's input fields, operator, value), effect (Hold / Block / Allow) and reason.
5. THE form SHALL warn when an Allow rule is chosen for a destructive operation ("This lets a vengeful spirit act without a human.") and require a confirm checkbox.
6. WHEN the Owner_Token is absent, THE Rules panel SHALL be read-only.
7. THE panel SHALL suggest one-click starter rules: "Hold transfers over 1000", "Block all destructive calls".

---

### Requirement 8: Theme, motion and accessibility

**User Story:** As any visitor, I want it to be beautiful and usable.

#### Acceptance Criteria

1. THE UI SHALL follow `.kiro/steering/ui-seance.md` (palette, serif headings, monospace transcripts, 300–800 ms motion).
2. ALL text SHALL meet WCAG AA contrast; ALL interactive elements SHALL be keyboard reachable with a visible focus ring.
3. Icon-only controls SHALL have `aria-label`s.
4. THE UI SHALL work with `prefers-reduced-motion: reduce` (no drifting, no flame animation).
5. THE Home_Page SHALL reach Lighthouse accessibility ≥ 95 in CI-free manual checks, and an automated `axe` run in Playwright SHALL report zero serious or critical violations on Home_Page and Service_Page.
6. NO UI string SHALL render an Owner_Token or token hash.

---

### Requirement 9: Social and sharing

**User Story:** As the team, I want the link to look good when posted.

#### Acceptance Criteria

1. THE app SHALL set Open Graph and Twitter card metadata using `public/lazarus-thumbnail-1500x1000.png`.
2. EACH Service_Page SHALL set a title of the form `<service name> — raised by Lazarus`.
