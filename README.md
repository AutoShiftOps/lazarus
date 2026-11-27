# Lazarus

**Raise dead SOAP services as live, safe MCP servers.**

Paste a WSDL URL. Lazarus turns every SOAP operation into an MCP tool, judges how dangerous each one is, and puts a human in front of the risky ones. Any MCP client (Claude, Kiro, Cursor) can then call a 20-year-old banking, insurance or SAP service in plain JSON.

Live demo: https://lazarus-ochre-eight.vercel.app/
Built for **Kiroween 2026**, Resurrection category, with Kiro.

## The problem

Enterprises run thousands of SOAP services that nobody wants to touch. Agents could use them, but giving an agent raw access to `CloseAccount` or `TransferFunds` is not a risk anyone will sign off on. Wrapping each service by hand takes weeks, and the safety work is usually skipped.

## What it does

1. **Summon.** Paste a WSDL URL. Lazarus parses it (SOAP 1.1 and 1.2, document and rpc styles, XSD types, nillable and optional fields) and generates a JSON Schema per operation.
2. **Serve.** Each service gets a live MCP endpoint at `/api/mcp/{id}` (stateless Streamable HTTP).
3. **Judge.** Every operation gets a risk class: read, write or destructive. A heuristic decides first. An optional Claude pass may only raise a class, never lower it.
4. **Hold.** Policy decides per call: allow, hold, block or ghost. A held call waits for a human to press and hold a candle in the browser, then executes at most once.
5. **Ghost mode.** Writes are answered with a made-up result and never reach the real service. You can show an agent a dangerous workflow with nothing at stake.
6. **Audit.** Every call is recorded as a redacted transcript: the JSON in, the SOAP request, the SOAP response, a one-line summary.

Rules are argument-aware. For example, "hold transfers over 1000" lets a 500 transfer through and holds a 2000 one.

## Try it in two minutes

1. Open the live site and raise the **Gravewood Bank** demo service. It is a SOAP bank that Lazarus hosts itself, so nothing real can be harmed.
2. Copy the MCP URL into your client, for example:
   `claude mcp add --transport http gravewoodbank <your MCP URL>`
3. Ask the agent for a balance. It runs straight through.
4. Ask it to close an account. The call is held. Open the service page, press and hold the candle, and watch it complete.
5. Switch on ghost mode and repeat. The agent gets a result, the bank is untouched.

You can also use the Commune form on the service page, which calls the same MCP endpoint as an agent would.

## How it is built

- Next.js 16 App Router (Cache Components), React 19, Tailwind v4, TypeScript strict, zod v4
- `@modelcontextprotocol/sdk`, stateless Streamable HTTP with JSON responses
- Upstash Redis for services, approvals (Lua compare-and-set), rules and transcripts
- A tree-based WSDL and XSD walker written for this project, not a SOAP client library
- Vitest and fast-check (about 1,600 tests), Playwright and axe for end-to-end and accessibility
- Vercel for hosting

```
WSDL URL -> summon -> parse + schema -> risk judge -> service in Redis
Agent -> /api/mcp/{id} -> policy (block > ghost > hold > allow)
           -> hold: candle approval -> at-most-once execute
           -> SOAP call (SSRF-safe) -> JSON result + redacted transcript
```

## Safety model

- **SSRF-safe outbound calls.** Blocked IP ranges include NAT64, 6to4, CGNAT and multicast. DNS is pinned to prevent rebinding, and WSDL imports are stripped so the library never fetches or reads anything on its own.
- **Policy order.** Block beats ghost, ghost beats hold, hold beats allow. Destructive operations are held by default. A condition that cannot be evaluated fails closed.
- **Approvals.** Compare-and-set claim, 15-minute expiry, execute at most once. Execution re-runs the policy, so a rule changed to block after an approval still wins.
- **LLM can only raise risk.** The model never sees call arguments, only operation names, documentation and field names. Its answer is validated, and a lower or invalid answer is ignored.
- **Tool-poisoning defence.** WSDL documentation is untrusted text that agents read. It is sanitised, capped, and always follows Lazarus's own risk line.
- **Redaction.** Secrets are redacted by key name before anything is stored, and summaries are built from fixed strings and counts only.

## Known limits

We would rather list these than have you find them.

- Risk judgement is heuristic first. The Claude refinement is optional and may only raise risk.
- Redaction is by key name, so a secret inside a free-text field is not caught.
- The service ID in the MCP URL is the only access control to that endpoint. Treat the URL as a secret. Approvals and transcripts of non-demo services need an owner token.
- `initialize` and `tools/list` are not rated or held.
- Services expire from storage after 30 days. The Gravewood demo sandbox lasts 60 minutes.
- An empty list and an absent field are the same thing in XML, so they round-trip as the same value.
- Unknown pages return HTTP 200 with `noindex` because of Cache Components.

## Built with Kiro

The `.kiro/` folder is committed on purpose.

- **Specs.** Five specs (requirements, design, tasks): summon, mcp-gateway, gravewood-bank, seance-ui, ask-the-medium (not built). Reviews of the specs caught real design bugs before any code, such as SSRF through library imports and a fail-open rule.
- **Steering.** Six steering files: product, tech and structure always on, plus UI, SOAP quirks and the demo script.
- **Hooks.** An agent hook runs `npm test` after every Kiro turn.
- **Property tests.** Dozens of properties with fast-check, including an independent oracle for the SSRF IP filter and a ledger-conservation test for the demo bank.

`KIRO_LOG.md` records the notable moments, including the ones where Kiro got it wrong and review caught it.

## Run it locally

```
npm install
# create .env.local with the variables below, using your own values
npm run dev
npm test
npm run e2e
```

Environment variables:

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | storage (required) |
| `LAZARUS_GRAVEWOOD_HOST` | host of the built-in demo bank |
| `NEXT_PUBLIC_SITE_URL` | absolute URL for metadata |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | optional risk refinement, off when unset |
| `LAZARUS_DEV_ALLOW_LOOPBACK` | dev and test only, allows localhost targets |

## Credits and disclosure

- The ghost illustration in the awakening ritual is AI-generated. All code, specs and the logo are the author's work made with Kiro.
- Scaffolded with create-next-app.
- MIT licensed.
