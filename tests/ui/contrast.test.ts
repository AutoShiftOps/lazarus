import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const palette = {
  background: "#14101c",
  surface: "#1d1728",
  surfaceRaised: "#261e34",
  text: "#ece6f5",
  muted: "#b3a9c7",
  candle: "#f6ad55",
  spectral: "#4fd1c5",
  vengeful: "#ff6b5b",
} as const;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const backgrounds = [
  ["background", palette.background],
  ["surface", palette.surface],
  ["surface-raised", palette.surfaceRaised],
] as const;

const foregrounds = [
  ["text", palette.text],
  ["muted", palette.muted],
  ["candle", palette.candle],
  ["spectral", palette.spectral],
  ["vengeful", palette.vengeful],
] as const;

describe("WCAG AA contrast", () => {
  it("computes known reference ratios correctly", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(ratio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  for (const [fgName, fg] of foregrounds) {
    for (const [bgName, bg] of backgrounds) {
      it(`${fgName} on ${bgName} is at least 4.5:1`, () => {
        const r = ratio(fg, bg);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("background-coloured text on a candle button is at least 4.5:1", () => {
    expect(ratio(palette.background, palette.candle)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

/**
 * Atmosphere layers sit behind text. Text must still pass AA on the brightest pixel each layer can
 * produce over the page background. Colours and opacities are read from globals.css, so editing
 * the CSS without keeping the budget fails here.
 */
describe("atmosphere keeps text contrast (peak layer colour over background)", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

  function cssVar(name: string): string {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    if (!m) throw new Error(`--${name} missing from globals.css`);
    return m[1].trim();
  }

  function blend(fg: string, bg: string, alpha: number): string {
    const f = parseInt(fg.slice(1), 16);
    const b = parseInt(bg.slice(1), 16);
    const mix = (shift: number): number =>
      Math.round(((f >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha));
    return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
  }

  const markSource = readFileSync(join(process.cwd(), "components", "LazarusMark.tsx"), "utf8");
  const haloStop = /<radialGradient id=\{id\("halo"\)\}>\s*<stop offset="0" stopColor="(#[0-9a-f]{6})" stopOpacity="([\d.]+)"/.exec(
    markSource,
  );
  if (!haloStop) throw new Error("halo gradient stop not found in LazarusMark.tsx");
  const haloColour = haloStop[1];
  const haloStopAlpha = Number(haloStop[2]);

  const batOpacities = [...css.matchAll(/\.bat-\d\s*\{\s*opacity:\s*([\d.]+);/g)].map((m) =>
    Number(m[1]),
  );
  const maxBat = Math.max(...batOpacities);

  const layers: [string, string][] = [
    ["moon", blend(cssVar("moon"), palette.background, Number(cssVar("moon-opacity")))],
    ["stars", blend(cssVar("star"), palette.background, Number(cssVar("star-opacity")))],
    ["brightest bat", blend(cssVar("bat"), palette.background, maxBat)],
    ["grave candle glow", blend(palette.candle, palette.background, Number(cssVar("glow-opacity")))],
    // #8b5cf6 is the sky glow colour hard-coded in components/Graveyard.tsx.
    ["graveyard sky", blend("#8b5cf6", palette.background, Number(cssVar("sky-glow-opacity")))],
    // Logo lantern: the white-teal halo and teal bloom reach beyond the mark, so they must keep AA.
    // The halo's peak alpha is its gradient stop opacity (read from LazarusMark.tsx) times the CSS
    // opacity; keyframes only ever scale that opacity down. The core, rim light and eyes are drawn
    // inside the logo box and never sit under text.
    ["lantern halo", blend(haloColour, palette.background, haloStopAlpha * Number(cssVar("halo-opacity")))],
    ["lantern bloom", blend(palette.spectral, palette.background, Number(cssVar("bloom-opacity")))],
  ];

  it("found all six bats and sane opacities", () => {
    expect(batOpacities).toHaveLength(6);
    expect(Math.min(...batOpacities)).toBeGreaterThanOrEqual(0.25);
    expect(maxBat).toBeLessThanOrEqual(0.5);
  });

  for (const [layer, colour] of layers) {
    for (const [fgName, fg] of foregrounds) {
      it(`${fgName} on ${layer} is at least 4.5:1`, () => {
        expect(ratio(fg, colour)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
