// lib/ui/origin.ts
// Derives the public origin of this app from request headers. Headers are untrusted,
// so the host and protocol are validated before they can end up in a URL.

import { parseHttpOrigin } from "./service-view";

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
const DEV_ORIGIN = "http://localhost:3000";

export type HeaderReader = { get(name: string): string | null };

function first(value: string | null): string {
  if (value === null) return "";
  return (value.split(",")[0] ?? "").trim();
}

/** Returns a validated http(s) origin, or null when the headers do not describe one. */
export function originFromHeaders(headers: HeaderReader, isDevelopment: boolean): string | null {
  const host = first(headers.get("x-forwarded-host")) || first(headers.get("host"));
  if (host !== "" && HOST_PATTERN.test(host)) {
    const forwarded = first(headers.get("x-forwarded-proto")).toLowerCase();
    const proto = forwarded === "http" || forwarded === "https" ? forwarded : isDevelopment ? "http" : "https";
    const origin = parseHttpOrigin(`${proto}://${host}`);
    if (origin !== null) return origin;
  }
  return isDevelopment ? DEV_ORIGIN : null;
}
