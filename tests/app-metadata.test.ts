import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "v", className: "c" });
  return { Cinzel: font, Inter: font, JetBrains_Mono: font };
});
vi.mock("../components/Atmosphere", () => ({ Atmosphere: () => null }));
vi.mock("../components/GhostCursor", () => ({ GhostCursor: () => null }));
vi.mock("../components/LazarusMark", () => ({ LazarusMark: () => null }));
vi.mock("../components/StillToggle", () => ({ StillToggle: () => null }));
vi.mock("../app/globals.css", () => ({}));

import robots from "../app/robots";
import sitemap from "../app/sitemap";
import { metadata, viewport } from "../app/layout";

describe("layout metadata", () => {
  it("has the social image, large twitter card and a short description", () => {
    const images = metadata.openGraph?.images;
    expect(JSON.stringify(images)).toContain("/lazarus-thumbnail-1500x1000.png");
    expect(JSON.stringify(metadata.twitter?.images)).toContain("/lazarus-thumbnail-1500x1000.png");
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    expect(metadata.description?.length).toBeGreaterThan(0);
    expect(metadata.description?.length).toBeLessThan(160);
    expect(viewport.themeColor).toBe("#14101c");
  });
});

describe("robots and sitemap", () => {
  it("disallows /api/ and /s/ and allows the home page", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.allow).toBe("/");
    expect(rule.disallow).toEqual(expect.arrayContaining(["/api/", "/s/"]));
  });
  it("lists only the home page", () => {
    expect(sitemap()).toHaveLength(1);
  });
});
