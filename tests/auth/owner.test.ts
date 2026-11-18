import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeOwner, isDemoService } from "../../lib/auth/owner";
import { generateOwnerToken, hashOwnerToken } from "../../lib/owner-token";
import type { ServiceDefinition } from "../../lib/soap/types";

function def(over: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return { name: "S", wsdlUrl: "https://example.com/x?wsdl", ports: [], warnings: [], ...over };
}

describe("authorizeOwner", () => {
  it("hash is stable and matches the stored hash for the right token", async () => {
    const { token, hash } = await generateOwnerToken();
    expect(await hashOwnerToken(token)).toBe(hash);
    expect(await hashOwnerToken(token)).toBe(hash);
    expect(await authorizeOwner(def({ ownerTokenHash: hash }), token)).toBe(true);
  });

  it("rejects a wrong token and a token for a different service", async () => {
    const a = await generateOwnerToken();
    const b = await generateOwnerToken();
    expect(await authorizeOwner(def({ ownerTokenHash: a.hash }), b.token)).toBe(false);
    expect(await authorizeOwner(def({ ownerTokenHash: a.hash }), a.token + "x")).toBe(false);
    expect(await authorizeOwner(def({ ownerTokenHash: a.hash }), a.token.slice(0, 20))).toBe(false);
  });

  it("returns false without throwing for malformed tokens", async () => {
    const { token, hash } = await generateOwnerToken();
    const d = def({ ownerTokenHash: hash });
    const bad: unknown[] = ["", null, undefined, 42, {}, [], [token], true, "a".repeat(10_000)];
    for (const b of bad) {
      await expect(authorizeOwner(d, b)).resolves.toBe(false);
    }
  });

  it("returns false when the definition has no usable hash", async () => {
    const { token } = await generateOwnerToken();
    expect(await authorizeOwner(def(), token)).toBe(false);
    expect(await authorizeOwner(def({ ownerTokenHash: "" }), token)).toBe(false);
    expect(await authorizeOwner(def({ ownerTokenHash: "short" }), token)).toBe(false);
    expect(await authorizeOwner(null, token)).toBe(false);
    expect(await authorizeOwner(undefined, token)).toBe(false);
  });
});

describe("isDemoService", () => {
  const saved = process.env.LAZARUS_GRAVEWOOD_HOST;
  const withHost = (host: string | undefined) => {
    if (host === undefined) delete process.env.LAZARUS_GRAVEWOOD_HOST;
    else process.env.LAZARUS_GRAVEWOOD_HOST = host;
  };
  const demo = (wsdlUrl: string) => isDemoService(def({ wsdlUrl }));

  beforeEach(() => withHost("gravewood.app"));
  afterEach(() => withHost(saved));

  it("accepts the configured host with a /api/gravewood/ path, any scheme and case", () => {
    expect(demo("https://gravewood.app/api/gravewood/abcd1234/wsdl")).toBe(true);
    expect(demo("http://gravewood.app/api/gravewood/abcd1234/wsdl")).toBe(true);
    expect(demo("https://GRAVEWOOD.APP/api/gravewood/abcd1234/wsdl")).toBe(true);
    expect(demo("https://gravewood.app:443/api/gravewood/x")).toBe(true);
    expect(demo("https://gravewood.app/api/gravewood/abc/wsdl")).toBe(true);
  });

  it("requires the /api/gravewood/ path prefix on the right host", () => {
    expect(demo("https://gravewood.app/other/wsdl")).toBe(false);
    expect(demo("https://gravewood.app/x")).toBe(false);
    expect(demo("https://gravewood.app/api/gravewood/../x")).toBe(false);
    expect(demo("https://gravewood.app/api/gravewoodx/")).toBe(false);
  });

  it("is case-insensitive for the configured value too", () => {
    withHost("  GraveWood.App ");
    expect(demo("https://gravewood.app/api/gravewood/x")).toBe(true);
  });

  it.each([
    "https://gravewood.evil.com/api/gravewood/a/wsdl",
    "https://gravewood.app.evil.com/api/gravewood/a/wsdl",
    "https://gravewood.app@evil.com/api/gravewood/a/wsdl",
    "https://evil.com/api/gravewood/gravewood.app",
    "https://evil.com/api/gravewood/?h=gravewood.app",
    "https://notgravewood.app/api/gravewood/x",
    "https://sub.gravewood.app/api/gravewood/x",
    "https://gravewood.app./api/gravewood/x",
    "https://gravewood.app.:443/api/gravewood/x",
    "ftp://gravewood.app/api/gravewood/x",
    "not a url",
    "",
    "//gravewood.app/api/gravewood/x",
  ])("rejects %j", (u) => {
    expect(demo(u)).toBe(false);
  });

  it("returns false for non-string or missing wsdlUrl without throwing", () => {
    expect(isDemoService(def({ wsdlUrl: undefined as unknown as string }))).toBe(false);
    expect(isDemoService(def({ wsdlUrl: 5 as unknown as string }))).toBe(false);
    expect(isDemoService(null)).toBe(false);
    expect(isDemoService(undefined)).toBe(false);
  });

  it("returns false for everything when the host is unset or blank", () => {
    withHost(undefined);
    expect(demo("https://gravewood.app/api/gravewood/x")).toBe(false);
    withHost("   ");
    expect(demo("https://gravewood.app/api/gravewood/x")).toBe(false);
  });

  it("compares the port only when the configured host has one", () => {
    withHost("localhost:3000");
    expect(demo("http://localhost:3000/api/gravewood/a/wsdl")).toBe(true);
    expect(demo("http://LOCALHOST:3000/api/gravewood/x")).toBe(true);
    expect(demo("http://localhost:3001/api/gravewood/x")).toBe(false);
    expect(demo("http://localhost/api/gravewood/x")).toBe(false);
    expect(demo("http://evil.com:3000/api/gravewood/x")).toBe(false);

    withHost("gravewood.app:8443");
    expect(demo("https://gravewood.app:8443/api/gravewood/x")).toBe(true);
    expect(demo("https://gravewood.app/api/gravewood/x")).toBe(false);

    withHost("gravewood.app");
    expect(demo("https://gravewood.app:8443/api/gravewood/x")).toBe(true);
  });

  it("rejects a malformed configured host", () => {
    withHost("gravewood.app/evil");
    expect(demo("https://gravewood.app/api/gravewood/x")).toBe(false);
    withHost("a@b");
    expect(demo("https://b/api/gravewood/x")).toBe(false);
  });
});
