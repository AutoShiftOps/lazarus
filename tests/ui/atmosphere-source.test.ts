import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...p: string[]): string => readFileSync(join(root, ...p), "utf8");
const css = read("app", "globals.css");

/** Returns the text between the braces of the block whose header starts at `headerStart`. */
function blockAt(source: string, headerStart: number): string {
  const open = source.indexOf("{", headerStart);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => ({
  name: m[1],
  body: blockAt(css, m.index ?? 0),
}));

/** Top-level `selector-list { body }` rules (outside @media / @keyframes). */
function topLevelRules(source: string): { selectors: string[]; body: string }[] {
  const rules: { selectors: string[]; body: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) break;
    const header = source.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const body = blockAt(source, i);
    if (!header.startsWith("@")) {
      rules.push({ selectors: header.split(",").map((s) => s.trim()), body });
    }
    i = open + body.length + 2;
  }
  return rules;
}

const reduceStart = css.indexOf("@media (prefers-reduced-motion: reduce)");
const reduceBlock = blockAt(css, reduceStart);

describe("atmosphere components", () => {
  it("Atmosphere renders an aria-hidden root", () => {
    expect(read("components", "Atmosphere.tsx")).toMatch(/className="atmosphere"\s+aria-hidden="true"/);
  });

  it("Graveyard renders an aria-hidden root", () => {
    expect(read("components", "Graveyard.tsx")).toMatch(/aria-hidden="true"/);
  });

  it("Heartbeat line is aria-hidden and the Raised label is real text", () => {
    const src = read("components", "Heartbeat.tsx");
    expect(src).toMatch(/<svg\s[^>]*aria-hidden="true"/);
    expect(src).toContain("<span>Raised</span>");
  });

  it("the atmosphere container is fixed, non-interactive, clipped and below content", () => {
    const rule = topLevelRules(css).find((r) => r.selectors.includes(".atmosphere"));
    expect(rule).toBeDefined();
    expect(rule?.body).toMatch(/position:\s*fixed/);
    expect(rule?.body).toMatch(/pointer-events:\s*none/);
    expect(rule?.body).toMatch(/overflow:\s*hidden/);
    expect(rule?.body).toMatch(/z-index:\s*0\b/);
  });

  it("Still mode toggle is a labelled button with aria-pressed", () => {
    const src = read("components", "StillToggle.tsx");
    expect(src).toContain("aria-pressed");
    expect(src).toContain("Still mode");
    expect(src).toContain('type="button"');
  });
});

describe("motion switch-off", () => {
  const animated = topLevelRules(css).filter((r) => /(^|;|\s)animation(-name)?:/.test(r.body));
  const kfNames = keyframes.map((k) => k.name);
  const used = animated.filter((r) => kfNames.some((n) => new RegExp(`animation(-name)?:\\s*${n}\\b`).test(r.body)));

  it("finds the new animated selectors (guards against a vacuous pass)", () => {
    const selectors = used.flatMap((r) => r.selectors);
    for (const s of [
      ".bat-path-ltr", ".bat-wing", ".flame-flicker", ".rise", ".fog-in", ".grave-glow", ".heartbeat-line",
      ".lantern-bloom", ".lantern-halo", ".lantern-eyes", ".aw-mote", '.awakening[data-spirit="rising"] .aw-mist',
    ]) {
      expect(selectors).toContain(s);
    }
  });

  it("has a prefers-reduced-motion block and a [data-still] rule for every animated selector", () => {
    expect(reduceStart).toBeGreaterThanOrEqual(0);
    const stillRules = topLevelRules(css).filter((r) => r.selectors.some((s) => s.includes('[data-still="true"]')));
    expect(stillRules.length).toBeGreaterThan(0);
    const stillSelectors = stillRules.flatMap((r) => r.selectors);
    const stillOff = stillRules.filter((r) => /animation:\s*none/.test(r.body)).flatMap((r) => r.selectors);
    expect(stillSelectors.length).toBeGreaterThan(0);

    // `.fade-in` is the pre-existing opacity-only 600 ms fade on <main>. It is the "simple fade"
    // that the steering file keeps under reduced motion, so it is deliberately not switched off.
    const keepsFade = new Set([".fade-in"]);
    for (const rule of used) {
      for (const sel of rule.selectors) {
        if (keepsFade.has(sel)) continue;
        expect(reduceBlock, `reduced-motion block covers ${sel}`).toContain(sel);
        expect(stillOff, `Still mode covers ${sel}`).toContain(`html[data-still="true"] ${sel}`);
      }
    }
    // the mist pseudo-elements are animated by mist-drift
    for (const sel of [".spirit-mist::before", ".spirit-mist::after"]) {
      expect(reduceBlock).toContain(sel);
      expect(stillOff).toContain(`html[data-still="true"] ${sel}`);
    }
  });

  it("hides bats in both modes", () => {
    expect(reduceBlock).toMatch(/\.bat\s*\{\s*display:\s*none/);
    expect(css).toMatch(/html\[data-still="true"\] \.bat\s*\{\s*display:\s*none/);
  });

  it("shows only the first 3 bats at <= 480px", () => {
    const m = css.indexOf("@media (max-width: 480px)");
    expect(m).toBeGreaterThanOrEqual(0);
    const body = blockAt(css, m);
    for (const n of [4, 5, 6]) expect(body).toContain(`.bat-${n}`);
    for (const n of [1, 2, 3]) expect(body).not.toContain(`.bat-${n}`);
    expect(body).toMatch(/display:\s*none/);
    expect(read("components", "Atmosphere.tsx")).toMatch(/BATS = \[/);
    expect((read("components", "Atmosphere.tsx").match(/path: "/g) ?? []).length).toBe(6);
  });
});

describe("animated properties", () => {
  // transform, opacity: compositor-only.
  // filter: only in fog-in (one heading, 700 ms, runs once); not a layout property.
  // stroke-dashoffset: only in heartbeat-trace; the SVG line has no layout impact.
  const ALLOWED = new Set(["transform", "opacity", "filter", "stroke-dashoffset"]);

  for (const kf of keyframes) {
    it(`@keyframes ${kf.name} only animates allowed properties`, () => {
      const decls = [...kf.body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      expect(decls.length).toBeGreaterThan(0);
      for (const prop of decls) expect(ALLOWED.has(prop), `${kf.name} uses ${prop}`).toBe(true);
    });
  }

  it("filter is used only by fog-in and stroke-dashoffset only by heartbeat-trace", () => {
    const using = (prop: string): string[] =>
      keyframes.filter((k) => new RegExp(`(^|[\\s;{])${prop}\\s*:`).test(k.body)).map((k) => k.name);
    expect(using("filter")).toEqual(["fog-in"]);
    expect(using("stroke-dashoffset")).toEqual(["heartbeat-trace"]);
  });

  it("includes the keyframes added by this task", () => {
    const names = keyframes.map((k) => k.name);
    for (const n of [
      "bat-ltr", "bat-rtl", "bat-ltr-b", "bat-flap", "flame-flicker", "rise", "fog-in", "glow-rise", "heartbeat-trace",
      "lantern-halo", "lantern-bloom", "lantern-eyes", "aw-drift", "aw-swirl",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("asset budget", () => {
  const LIMIT = 20 * 1024;
  const preExistingPublic = new Set(["lazarus-icon-1024.png", "lazarus-logo.svg", "lazarus-thumbnail-1500x1000.png"]);

  it("every component file is at most 20 KB and the new ones exist", () => {
    for (const f of ["Atmosphere.tsx", "Graveyard.tsx", "Heartbeat.tsx", "StillToggle.tsx", "LazarusMark.tsx", "SpiritAwakening.tsx"]) {
      expect(statSync(join(root, "components", f)).size).toBeLessThanOrEqual(LIMIT);
    }
    for (const f of readdirSync(join(root, "components"))) {
      expect(statSync(join(root, "components", f)).size, f).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("any file in public/ beyond the pre-existing ones is at most 20 KB", () => {
    for (const f of readdirSync(join(root, "public"))) {
      if (preExistingPublic.has(f)) continue;
      expect(statSync(join(root, "public", f)).size, f).toBeLessThanOrEqual(LIMIT);
    }
  });
});

describe("logo lantern and spirit awakening", () => {
  const mark = read("components", "LazarusMark.tsx");
  const scene = read("components", "SpiritAwakening.tsx");

  it("every LazarusMark glow layer is aria-hidden and the image keeps its alt prop", () => {
    for (const cls of ["lantern-bloom", "lantern-halo", "lantern-core"]) {
      expect(mark).toMatch(new RegExp(`className="${cls}[^"]*"\\s+aria-hidden="true"`));
    }
    expect(mark).toMatch(/<svg\s[^>]*className="lantern-eyes"[^>]*aria-hidden="true"/);
    expect(mark).toContain("alt={alt}");
    expect(mark).toContain('src="/lazarus-logo.svg"');
  });

  it("the SpiritAwakening scene svg is aria-hidden and the stage label is real text", () => {
    expect(scene).toMatch(/<svg\s[^>]*aria-hidden="true"/);
    expect(scene).toContain("{label}");
  });

  it("the stage text lives in an aria-live region in SummonForm", () => {
    expect(read("components", "SummonForm.tsx")).toMatch(/aria-live="polite"[^>]*>\s*\{busy \? <SpiritAwakening/);
  });

  it("lantern layers and the awakening scene never take pointer events", () => {
    const rule = topLevelRules(css).find((r) => r.selectors.includes(".lantern-bloom"));
    expect(rule?.selectors).toEqual([".lantern-bloom", ".lantern-halo", ".lantern-core", ".lantern-eyes"]);
    expect(rule?.body).toMatch(/pointer-events:\s*none/);
    expect(rule?.body).toMatch(/position:\s*absolute/);
  });

  it("the lantern core stays inside the mark box (it never sits under text)", () => {
    const rule = topLevelRules(css).find((r) => r.selectors.length === 1 && r.selectors[0] === ".lantern-core");
    expect(rule).toBeDefined();
    const px = (prop: string): number => Number(new RegExp(`${prop}:\\s*([\\d.]+)%`).exec(rule?.body ?? "")?.[1]);
    expect(px("left") + px("width")).toBeLessThanOrEqual(100);
    expect(px("top") + px("height")).toBeLessThanOrEqual(100);
  });

  it("reduced motion and Still mode zero the awakening transitions but keep end states", () => {
    expect(reduceBlock).toMatch(/\.awakening \*[\s\S]*transition-duration:\s*0ms/);
    expect(css).toMatch(/html\[data-still="true"\] \.awakening \*[\s\S]*transition-duration:\s*0ms/);
  });

  it("awakening transitions last 300-800 ms and use only transform and opacity", () => {
    const rule = topLevelRules(css).find((r) => r.selectors.includes(".aw-halo"));
    const transition = /transition:([\s\S]*?);/.exec(rule?.body ?? "")?.[1] ?? "";
    const parts = transition.split(",").map((p) => p.trim().split(/\s+/));
    expect(parts.length).toBeGreaterThan(0);
    for (const [prop, dur] of parts) {
      expect(["transform", "opacity"]).toContain(prop);
      const ms = Number.parseInt(dur, 10);
      expect(ms).toBeGreaterThanOrEqual(300);
      expect(ms).toBeLessThanOrEqual(800);
    }
  });

  it("the scene markup is under 12 KB", () => {
    expect(statSync(join(root, "components", "SpiritAwakening.tsx")).size).toBeLessThan(12 * 1024);
  });

  it("public/lazarus-logo.svg is unchanged", () => {
    // Approach: compare a SHA-256 of the file bytes (recorded from the file in git HEAD, which has
    // no diff in the working tree when this task was done).
    const bytes = readFileSync(join(root, "public", "lazarus-logo.svg"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("4aa9e97320724d22543f24d94ef5de3218f9cf8f1ec3ba73510844280363ed85");
  });
});
