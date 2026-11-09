# Kiro log

- 2026-10-31: Repo created. Six steering files added (product, tech, structure always; ui-seance and soap-quirks by fileMatch; demo-script manual).
- 2026-11-09: Scaffolded Next.js with create-next-app (starter template, disclosed per rules).
- 2026-11-09: Second review pass: fixed round-trip null bug, local datetimes, absolute mcpUrl, extra SSRF ranges + DNS rebinding. Approved requirements.
- 2026-11-09: Design review: caught SSRF bypass via soap library imports, non-serialisable zod in Redis, missing SOAP metadata, TLS-to-IP bug.