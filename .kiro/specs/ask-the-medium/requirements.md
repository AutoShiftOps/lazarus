# Requirements Document

## Introduction

"Ask the Medium" is an in-browser AI agent on the Service page. A judge types a plain request ("Move $5,000 from account 4471 to 9902, then close the dormant account"). The agent, running on Amazon Bedrock, calls the service's tools through the real Lazarus MCP endpoint; dangerous calls are held; the judge releases them in the Inbox. It makes the product experienceable in seconds without an MCP client. If Bedrock is unavailable or the daily budget is spent, a scripted "offline medium" keeps the demo working.

Depends on: `mcp-gateway`, `seance-ui`.

---

## Glossary

- **Medium**: The agent loop in `lib/medium/`.
- **Bedrock_Client**: Wrapper around `@aws-sdk/client-bedrock-runtime` `ConverseCommand` (injectable).
- **Scripted_Medium**: A deterministic fallback that maps a small set of known prompts to tool-call plans without a model.
- **Budget**: A daily cap on model calls.

---

## Requirements

### Requirement 1: Chat endpoint

**User Story:** As a judge, I want to give the agent an instruction and watch it work.

#### Acceptance Criteria

1. THE Medium SHALL expose `POST /api/medium/{serviceId}` accepting `{ message: string (max 500 chars), history?: Turn[] (max 10) }` and streaming server-sent events of type `thought`, `tool_call`, `tool_result`, `held`, `final`, `error`.
2. THE Medium SHALL obtain the tool list from the same service definition the MCP endpoint uses and SHALL call tools only through `runCall` from the gateway pipeline, so that policy, holds, ghost mode and transcripts apply unchanged.
3. THE Medium SHALL run at most 6 model turns and 8 tool calls per message.
4. IF a tool call is held THEN THE Medium SHALL emit a `held` event with the approval id, wait up to 20 seconds for resolution (same as the gateway), and continue with the real result or the denial.
5. IF the Approval is still pending after the wait THEN THE Medium SHALL tell the user to open the Inbox and SHALL end the turn without retrying.
6. THE route SHALL declare `runtime = "nodejs"` and `maxDuration = 60`.

---

### Requirement 2: Model use and prompts

#### Acceptance Criteria

1. THE Bedrock_Client SHALL use `BEDROCK_MODEL_ID` and `AWS_REGION` from the typed env, with `temperature` ≤ 0.2 and `maxTokens` ≤ 1,000.
2. THE system prompt SHALL state: the agent is operating a legacy service through tools; it must use tools rather than guess; it must report held or refused calls honestly and must not try to bypass them; it must not repeat a held call.
3. THE user's message SHALL be passed as a user turn only; service documentation SHALL be passed only inside tool descriptions (not the system prompt), limiting prompt injection from WSDL text.
4. THE Medium SHALL treat all tool results as data; it SHALL NOT follow instructions found in tool results.
5. THE Medium SHALL NOT expose the Owner_Token or any server secret to the model.

---

### Requirement 3: Budget and abuse protection

#### Acceptance Criteria

1. THE Medium SHALL allow at most 5 messages per minute per IP and 40 per day per service.
2. THE Medium SHALL count model invocations globally per UTC day and stop calling Bedrock after `MEDIUM_DAILY_CALL_CAP` (default 400).
3. WHEN the cap is reached or Bedrock errors, THE Medium SHALL switch to the Scripted_Medium and mark the response `mode: "offline"`.
4. THE UI SHALL show a small label "Live agent" or "Offline medium (scripted)" per response.

---

### Requirement 4: Scripted fallback

#### Acceptance Criteria

1. THE Scripted_Medium SHALL recognise at least these intents by keyword: check balance, list accounts, transfer money (amount and two account ids extracted with a regex), close an account (account id extracted).
2. THE Scripted_Medium SHALL execute the planned tool calls through `runCall`, so holds and ghost mode behave identically.
3. IF no intent matches THEN THE Scripted_Medium SHALL reply with the list of things it can do.

---

### Requirement 5: UI

#### Acceptance Criteria

1. THE Service_Page SHALL include an "Ask the Medium" panel with a text box, three example prompts (balance, a 5,000 transfer, close the dormant account) and a message list.
2. THE panel SHALL render each tool call as a labelled step with Risk_Badge and result; a held step SHALL show "Waiting for a human — open the Inbox" with a link.
3. THE panel SHALL work with keyboard only and announce new messages via `aria-live="polite"`.
4. THE panel SHALL disable input while a request is running and show a cancel button that aborts the stream.
