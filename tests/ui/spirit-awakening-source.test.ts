import { existsSync, readFileSync } from "node:fs";
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
    expect(awCss).not.toMatch(/animation:[^;]*\baw-(?!drift|tremble|float|breathe|glow)/);
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
    expect(awCss).toContain('.aw-rune[data-lit="true"]');
  });

  it("has the scene layers and a static clip-path mask for the hand", () => {
    for (const cls of ["aw-halo", "aw-mist", "aw-mound", "aw-crack", "aw-stone", "aw-ghost", "aw-hand", "aw-eye-glow", "aw-wisp"]) {
      expect(scene).toContain(cls);
    }
    expect(scene).toContain('clipPath="url(#aw-clip)"');
    expect(awCss).not.toMatch(/clip-path\s*:/);
  });

  it("draws the ghost with next/image from the painted asset, hidden from assistive tech", () => {
    expect(scene).toContain('import Image from "next/image"');
    expect(scene).toContain('src="/ritual/ghost.png"');
    expect(scene).toMatch(/alt=""/);
    expect(scene).toMatch(/aria-hidden="true"\s+width=\{832\}\s+height=\{1248\}/);
    expect(scene).toContain("quality={80}");
    expect(scene).toContain("preload");
    expect(scene).not.toMatch(/<animate|<image|https?:\/\/|<feTurbulence/);
    expect(scene).not.toMatch(/aw-robe|aw-hood|aw-ghost-g/);
  });

  it("the ghost illustration exists in public/ritual", () => {
    expect(existsSync(join(process.cwd(), "public", "ritual", "ghost.png"))).toBe(true);
  });

  it("composites with screen blend, a bottom mask and a smooth eased rise", () => {
    expect(awCss).toMatch(/\.aw-ghost-pos\s*\{[^}]*mix-blend-mode:\s*screen/);
    expect(awCss).toMatch(/\.aw-ghost-pos\s*\{[^}]*mask-image:\s*linear-gradient\([^)]*transparent 100%\)/);
    expect(awCss).toMatch(/transition:\s*transform 2200ms cubic-bezier[^;]*,\s*opacity 1800ms ease-out/);
    expect(awCss).not.toMatch(/\.aw-ghost\s*\{[^}]*steps\(/);
  });

  it("the old flame-with-eyes artwork is gone", () => {
    expect(scene).not.toContain("aw-eyes-open");
    expect(scene).not.toContain("aw-eyes-closed");
    expect(scene).not.toContain("aw-spirit-grad");
  });

  it("reduced motion and Still mode switch the scene animations off", () => {
    for (const sel of [
      ".aw-mist-a",
      '.awakening[data-phase="awake"] .aw-float',
      '.awakening[data-phase="awake"] .aw-breathe',
      '.awakening[data-phase="awake"] .aw-eye-glow',
      '.awakening[data-phase="stirring"] .aw-mound-g',
    ]) {
      expect(css).toContain(`  ${sel},`);
      expect(css).toContain(`html[data-still="true"] ${sel},`);
    }
  });
});
