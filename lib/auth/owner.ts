// lib/auth/owner.ts
// Owner authorisation and demo-service detection. Hashing lives in lib/owner-token.ts.

import { gravewoodHost } from "../env";
import { verifyOwnerToken } from "../owner-token";
import type { ServiceDefinition } from "../soap/types";

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_TOKEN_LENGTH = 256;

/**
 * True when `token` is the owner token for `def`. Accepts unknown input at the
 * boundary; returns false for anything malformed and never throws.
 */
export async function authorizeOwner(
  def: Pick<ServiceDefinition, "ownerTokenHash"> | null | undefined,
  token: unknown,
): Promise<boolean> {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    const hash = def?.ownerTokenHash;
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
    return await verifyOwnerToken(token, hash);
  } catch {
    return false;
  }
}

const CONFIG_RE = /^(?:https?:\/\/)?([^/:@\s]+)(?::(\d{1,5}))?\/?$/;

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * True only when the hostname of `def.wsdlUrl` equals the configured Gravewood
 * host exactly (case-insensitive) AND its parsed pathname starts with
 * `/api/gravewood/`. If the configured host has a port, the
 * effective port must match too. Unset config, invalid URLs and look-alikes
 * return false; never throws.
 */
export function isDemoService(def: Pick<ServiceDefinition, "wsdlUrl"> | null | undefined): boolean {
  try {
    const configured = gravewoodHost();
    if (!configured) return false;
    const m = CONFIG_RE.exec(configured);
    if (!m) return false;
    const wantHost = m[1];
    const wantPort = m[2];

    const raw = def?.wsdlUrl;
    if (typeof raw !== "string") return false;
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname.toLowerCase() !== wantHost) return false;
    if (!url.pathname.startsWith("/api/gravewood/")) return false;
    if (wantPort !== undefined && effectivePort(url) !== String(Number(wantPort))) return false;
    return true;
  } catch {
    return false;
  }
}
