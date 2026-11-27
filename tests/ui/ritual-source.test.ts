import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");
const ritual = read("components", "AwakeningRitual.tsx");
const form = read("components", "SummonForm.tsx");
const page = read("app", "page.tsx");

describe("AwakeningRitual source", () => {
  it("is a fixed, full-viewport, high z-index overlay", () => {
    expect(ritual).toMatch(/className="[^"]*\bfixed\b[^"]*\binset-0\b/);
    expect(ritual).toMatch(/z-\[(\d{3,})\]/);
  });

  it("portals to document.body after mount, covering the viewport above the header", () => {
    expect(ritual).toContain("createPortal(");
    expect(ritual).toContain("document.body,");
    expect(ritual).toContain("useSyncExternalStore");
    expect(ritual).toMatch(/\bh-dvh\b/);
    expect(ritual).toMatch(/\bw-screen\b/);
    expect(ritual).toMatch(/bg-background/);
  });

  it("has a Skip button that is a real, focusable button", () => {
    expect(ritual).toMatch(/<button[^>]*type="button"[\s\S]*?>\s*Skip\s*<\/button>/);
    expect(ritual).toMatch(/skipRef\.current\?\.focus\(\)/);
  });

  it("puts the stage text in an aria-live region and hides the scene from assistive tech", () => {
    expect(ritual).toMatch(/aria-live="polite"/);
    expect(ritual).toMatch(/<div aria-hidden="true"[^>]*>\s*<SpiritAwakening/);
  });

  it("locks body scroll and restores the previous value on cleanup", () => {
    expect(ritual).toContain('document.body.style.overflow = "hidden"');
    expect(ritual).toMatch(/document\.body\.style\.overflow = previous/);
  });

  it("restores focus to the opener on close", () => {
    expect(ritual).toMatch(/opener\.focus\(\)/);
  });

  it("cleans up its timer on unmount", () => {
    expect(ritual).toMatch(/const id = setInterval\(/);
    expect(ritual).toMatch(/return \(\) => clearInterval\(id\)/);
    expect((ritual.match(/setInterval\(/g) ?? []).length).toBe(1);
    expect(ritual).not.toContain("setTimeout(");
  });

  it("takes its timing from ritual-timing rather than its own numbers", () => {
    expect(ritual).toContain('from "../lib/ui/ritual-timing"');
    expect(ritual).toContain("ritualState(");
  });
});

describe("SummonForm and home page", () => {
  it("SummonForm opens the ritual, and navigates only from the ritual's done callback", () => {
    expect(form).toContain("<AwakeningRitual");
    expect(form).not.toContain("<SpiritAwakening");
    expect((form.match(/router\.push\(/g) ?? []).length).toBe(1);
    expect(form).toMatch(/function finishRitual\(\)[\s\S]{0,120}router\.push\(/);
    expect(form).toContain("onDone={finishRitual}");
  });

  it("the page renders exactly one large mark, inside the desktop-only art column", () => {
    const marks = page.match(/<LazarusMark\b/g) ?? [];
    expect(marks.length).toBe(1);
    const at = page.indexOf("<LazarusMark");
    const wrapperStart = page.lastIndexOf("<div", at);
    expect(page.slice(wrapperStart, at)).toMatch(/className="hidden [^"]*\blg:flex\b/);
    // after the Graveyard, never stacked above the heading
    expect(at).toBeGreaterThan(page.indexOf("<Graveyard"));
    expect(at).toBeGreaterThan(page.indexOf("<h1"));
  });

  it("the header keeps only a plain mark, linked home", () => {
    expect(read("app", "layout.tsx")).toMatch(/<LazarusMark size=\{\d+\} variant="plain"/);
    expect(read("app", "layout.tsx")).toMatch(/<Link href="\/"/);
  });
});
