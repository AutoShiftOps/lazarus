import { describe, expect, it } from "vitest";
import { originFromHeaders } from "../../lib/ui/origin";

function h(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe("originFromHeaders", () => {
  it("prefers x-forwarded-host and x-forwarded-proto", () => {
    expect(
      originFromHeaders(h({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https", host: "internal:3000" }), false),
    ).toBe("https://app.example.com");
  });

  it("uses host and defaults to https in production", () => {
    expect(originFromHeaders(h({ host: "app.example.com" }), false)).toBe("https://app.example.com");
  });

  it("defaults to http in development and keeps the port", () => {
    expect(originFromHeaders(h({ host: "localhost:3001" }), true)).toBe("http://localhost:3001");
  });

  it("takes the first value of a comma list", () => {
    expect(originFromHeaders(h({ "x-forwarded-host": "a.example.com, b.example.com", "x-forwarded-proto": "https, http" }), false)).toBe(
      "https://a.example.com",
    );
  });

  it("rejects hostile hosts and protocols", () => {
    expect(originFromHeaders(h({ host: "evil.com/path?x=1" }), false)).toBeNull();
    expect(originFromHeaders(h({ host: "a@evil.com" }), false)).toBeNull();
    expect(originFromHeaders(h({ host: "ok.example.com", "x-forwarded-proto": "javascript" }), false)).toBe("https://ok.example.com");
  });

  it("falls back to localhost only in development", () => {
    expect(originFromHeaders(h({}), true)).toBe("http://localhost:3000");
    expect(originFromHeaders(h({}), false)).toBeNull();
    expect(originFromHeaders(h({ host: "bad host" }), true)).toBe("http://localhost:3000");
  });
});
