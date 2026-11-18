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
