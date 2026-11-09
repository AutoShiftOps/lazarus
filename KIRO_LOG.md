# Kiro log

One line per notable Kiro moment. This becomes the hackathon write-up.

- 2026-10-31: Repo created. Six steering files added (product, tech, structure always; ui-seance and soap-quirks by fileMatch; demo-script manual).
- 2026-11-09: Scaffolded Next.js with create-next-app (starter template, disclosed per rules).
- 2026-11-09: Reviewed spec 1 requirements; pushed back on SSRF, duplicate SOAP bindings, nillable mapping, WSDL 2.0 scope.
- 2026-11-09: Second review pass: fixed round-trip null bug, local datetimes, absolute mcpUrl, extra SSRF ranges + DNS rebinding. Approved requirements.
- 2026-11-09: Design review: caught SSRF bypass via soap library imports, non-serialisable zod in Redis, missing SOAP metadata, TLS-to-IP bug. Design approved after one revision.
- 2026-11-09: Generated tasks.md for summon. Reviewed it: made all property-based tests and the SSRF import test (4.5) required instead of optional, pinned zod v4 for z.toJSONSchema, and noticed task 1 was missing from Kiro's dependency graph.
- 2026-11-09: Downloaded Calculator and CountryInfoService WSDLs into fixtures/ by hand so contract tests never hit the network.
- 2026-11-09: Added agent hook test-on-agent-stop (trigger: Agent Stop, action: run `npm test`), so every Kiro turn is checked by the test suite and failures go straight back to the agent.
- 2026-11-09: Adversarial review of isBlockedIp found 9 bypasses (NAT64, 6to4, IPv4-compatible IPv6, CGNAT, multicast/broadcast, leading-zero octets); Kiro extended the ranges, made parsing fail closed, and grew the suite to 27 tests.