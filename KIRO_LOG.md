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
- 2026-11-09: Property test for isBlockedIp uses Node's net.BlockList as an independent oracle (1,000 random IPv4 + IPv6 per run, plus in-range generators). Kiro found BlockList treats ::ffff:0:0/96 rules as matching plain IPv4, so it split the oracle into separate v4/v6 lists. Extra 40,000-case check: 0 mismatches.
- 2026-11-16: Kiro reported task 4.5 complete with "13 tests appended", but the test file was untouched on disk and the suite was still 38. Its own report quoted the old count while claiming new tests, and it never ran the suite. Caught by diffing before commit; re-ran with an explicit test plan. Second pass added a vacuous assertion (a counter never incremented) — caught in review and replaced with an http.request spy.
- 2026-11-16: Read the soap library source before implementing schema inlining and found that its WSDL constructor opens every import/include location itself, including as local file paths for non-HTTP document URIs. This turned Stage 4 from "add the schemas" into "strip every location", enforced by a test that mixes fetched, failed, file: and wsdl:import references. Review of Kiro's result then found the strip's tag pattern missed non-ASCII prefixes.
- 2026-11-16: Replaced the soap library with a tree-based Stage 5 + XSD walker; Kiro flagged the rpc/encoded rule conflict itself.