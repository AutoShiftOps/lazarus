import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");
const scene = read("components", "SpiritAwakening.tsx");
const css = read("app", "globals.css");

/** CSS from the awakening section up to the ritual-pulse rule. */
const awCss = css.slice(css.indexOf("/* ---- Spirit awakening scene"), css.indexOf(".ritual-pulse {"));

describe("SpiritAwakening source", () => {
  it("keyframes and transitions in the scene touch only transform and opacity", () => {
    const frames = [...awCss.matchAll(/@keyframes\s+(aw-[\w-]+)\s*\{([\s\S]*?\n\})/g)];
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const [, name, body] of frames) {
      for (const [, prop] of body.matchAll(/([\w-]+)\s*:/g)) {
        expect(["transform", "opacity"], `${name} uses ${prop}`).toContain(prop);
      }
    }
    for (const [, value] of awCss.matchAll(/transition:([^;]+);/g)) {
      for (const part of value.split(/,(?![^(]*\))/)) {
        expect(["transform", "opacity"]).toContain(part.trim().split(/\s+/)[0]);
      }
    }
    expect(awCss).not.toMatch(/animation:[^;]*\baw-(?!drift|tremble|float|sway|breathe)/);
  });

  it("renders all four stage phases and CSS rules for each", () => {
    for (const phase of ["fetching", "reading", "stirring", "awake"]) {
      expect(scene).toContain(`"${phase}"`);
    }
    expect(scene).toContain("data-phase={phase}");
    expect(scene).toContain("data-stage={stage}");
    for (const phase of ["stirring", "awake"]) {
      expect(awCss).toContain(`.awakening[data-phase="${phase}"]`);
    }
    expect(awCss).toContain('.awakening[data-eyes="blazing"]');
    expect(awCss).toContain('.aw-rune[data-lit="true"]');
  });

  it("has the scene layers and a static clip-path mask for the rise", () => {
    for (const cls of ["aw-halo", "aw-mist", "aw-mound", "aw-crack", "aw-stone", "aw-ghost", "aw-hand", "aw-eyes", "aw-wisp"]) {
      expect(scene).toContain(cls);
    }
    expect(scene).toContain('clipPath="url(#aw-clip)"');
    expect(awCss).not.toMatch(/clip-path\s*:/);
  });

  it("uses one static soft-edge filter with a fixed seed and no external assets", () => {
    expect(scene).toMatch(/<feTurbulence[^>]*seed="\d+"/);
    expect(scene).toContain("<feDisplacementMap");
    expect(scene).toContain("<feGaussianBlur");
    expect(scene).not.toMatch(/<animate|<image|https?:\/\/|\.svg|\.png/);
  });

  it("the old flame-with-eyes artwork is gone", () => {
    expect(scene).not.toContain("aw-eyes-open");
    expect(scene).not.toContain("aw-eyes-closed");
    expect(scene).not.toContain("aw-spirit-grad");
  });

  it("reduced motion and Still mode switch the scene animations off", () => {
    for (const sel of [".aw-mist-a", '.awakening[data-phase="awake"] .aw-float', '.awakening[data-phase="stirring"] .aw-mound-g']) {
      expect(css).toContain(`  ${sel},`);
      expect(css).toContain(`html[data-still="true"] ${sel},`);
    }
  });
});
