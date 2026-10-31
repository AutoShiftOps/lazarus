---
inclusion: always
---
# Project structure

```
app/                  Next.js routes and pages
  page.tsx            Home: summon a service by WSDL URL
  s/[id]/page.tsx     Service page: operations, commune form, MCP config, transcripts
  api/summon/         POST: fetch + parse a WSDL, save to the registry
  api/mcp/[id]/       MCP Streamable HTTP endpoint for one service
components/           UI components (seance theme)
lib/
  soap/               WSDL parsing, schema generation, JSON <-> XML translator
  mcp/                MCP server factory and tool registration
  registry/           Redis-backed storage for services and transcripts
  env.ts              Typed environment variables
fixtures/             Sample WSDL files used by tests
tests/                Vitest unit and property-based tests
e2e/                  Playwright tests
.kiro/                Specs, hooks and steering (committed, never gitignored)
KIRO_LOG.md           One line per notable Kiro moment, for the hackathon write-up
```

## Rules
- Tests mirror `lib/` paths, e.g. `lib/soap/translator.ts` -> `tests/soap/translator.test.ts`.
- Every new WSDL in `fixtures/` gets a matching contract test.
