---
inclusion: always
---
# Tech stack and conventions

## Stack
- Next.js (App Router) + TypeScript in strict mode
- `soap` npm package for WSDL parsing and SOAP calls
- `@modelcontextprotocol/sdk` with Streamable HTTP transport for MCP endpoints
- zod for all schemas and input validation
- Upstash Redis for the service registry and transcripts
- Tailwind CSS + Framer Motion for the UI
- Vitest + fast-check for unit and property-based tests; Playwright for end-to-end tests
- Deploy target: Vercel

## Conventions
- No `any`. Use explicit types or zod-inferred types.
- Every SOAP call goes through `lib/soap/translator.ts`. No direct SOAP calls anywhere else.
- Every outbound SOAP call has a 10-second timeout.
- Keep JSON <-> XML translation in pure functions so they can be property-tested.
- Read environment variables only through a typed `lib/env.ts`; never hard-code secrets.
- Small, focused modules with one responsibility per file.
- Use current stable library versions and check current docs before using an API.

## Commands
- `npm run dev` - local dev server
- `npm test` - Vitest (unit + property-based)
- `npm run e2e` - Playwright
- `npm run lint` - ESLint + type check
