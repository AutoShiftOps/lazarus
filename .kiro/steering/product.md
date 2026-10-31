---
inclusion: always
---
# Product: Lazarus

Lazarus raises dead SOAP web services as live MCP servers, so any AI agent can call them.

## Users
- Agent builders who need their agents to reach legacy enterprise systems
- Enterprise integration teams with SOAP estates (banking, insurance, telecom, SAP)

## Core flow
1. The user pastes a WSDL URL ("summon").
2. Lazarus parses it and turns every SOAP operation into an MCP tool with a JSON Schema.
3. Lazarus serves a live MCP endpoint per service at `/api/mcp/{id}`.
4. Agents call tools in JSON; Lazarus builds the SOAP envelope, calls the service and returns JSON.
5. Every call is recorded as a transcript (the "Ouija transcript") shown in the UI.

## Principles
- Never call a legacy service except for an explicit tool call or a user's "commune" action.
- Never store credentials in plain text or write them into transcripts.
- Clear errors over silent failures: a SOAP fault becomes a readable MCP tool error.
- The theme is spooky (seance, spirits, Ouija), but function always comes first.

## Demo services (public, free)
- Calculator: http://www.dneonline.com/calculator.asmx?WSDL
- CountryInfoService: http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL

## Context
Built for the Kiroween 2026 hackathon, Resurrection category. Deadline: Dec 4, 2026.
