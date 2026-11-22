import { siteEnv, type SiteEnv } from "./env";

const FALLBACK = "http://localhost:3000";

function parseOrigin(raw: string | undefined, addHttps: boolean): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const candidate = addHttps && !/^https?:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Pure resolver: explicit site URL, then Vercel production host, then localhost. */
export function resolveSiteUrl(env: SiteEnv): URL {
  const origin =
    parseOrigin(env.NEXT_PUBLIC_SITE_URL, false) ??
    parseOrigin(env.VERCEL_PROJECT_PRODUCTION_URL, true) ??
    FALLBACK;
  return new URL(origin);
}

export function siteUrl(): URL {
  return resolveSiteUrl(siteEnv());
}

export const SOCIAL_IMAGE = {
  url: "/lazarus-thumbnail-1500x1000.png",
  width: 1500,
  height: 1000,
  alt: "Lazarus: a candle-lit seance raising dead SOAP services as MCP servers",
} as const;
