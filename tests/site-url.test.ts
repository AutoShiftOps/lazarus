import { describe, expect, it } from "vitest";
import { resolveSiteUrl } from "../lib/site-url";

const none = { NEXT_PUBLIC_SITE_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined };

describe("resolveSiteUrl", () => {
  it("prefers NEXT_PUBLIC_SITE_URL", () => {
    const url = resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://lazarus.example/", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" });
    expect(url.origin).toBe("https://lazarus.example");
  });
  it("falls back to the Vercel production host with https", () => {
    expect(resolveSiteUrl({ ...none, VERCEL_PROJECT_PRODUCTION_URL: "lazarus.vercel.app" }).origin).toBe("https://lazarus.vercel.app");
  });
  it("falls back to localhost", () => {
    expect(resolveSiteUrl(none).origin).toBe("http://localhost:3000");
  });
  it("ignores invalid values", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "not a url", VERCEL_PROJECT_PRODUCTION_URL: "  " }).origin).toBe("http://localhost:3000");
    expect(resolveSiteUrl({ ...none, NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" }).origin).toBe("http://localhost:3000");
  });
});
