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
      ".bat-path-ltr", ".bat-wing", ".rise", ".fog-in", ".grave-glow", ".heartbeat-line",
      ".lm-bloom", ".lm-halo", ".lm-core", ".lm-rim", ".lm-eyes", ".lm-eye-glow", ".aw-mist-a", '.awakening[data-phase="awake"] .aw-float',
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
      "bat-ltr", "bat-rtl", "bat-ltr-b", "bat-flap", "rise", "fog-in", "glow-rise", "heartbeat-trace",
      "lm-halo", "lm-bloom", "lm-core", "lm-rim", "lm-eyes", "lm-eye-glow", "aw-drift-a", "aw-float",
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

  const BRACES = [
    "M238 222 c -11 0 -11 5 -11 13 c 0 9 -4 11 -10 11 c 6 0 10 2 10 11 c 0 8 0 13 11 13",
    "M278 222 c 11 0 11 5 11 13 c 0 9 4 11 10 11 c -6 0 -10 2 -10 11 c 0 8 0 13 -11 13",
  ];

  it("the mark is one aria-hidden inline SVG that draws the untouched logo via <image href>", () => {
    expect(mark).toMatch(/<svg\s[^>]*viewBox="-128 -128 768 768"[^>]*aria-hidden="true"/);
    expect((mark.match(/<svg\b/g) ?? []).length).toBe(1);
    expect(mark).toContain('<image href="/lazarus-logo.svg" x="0" y="0" width="512" height="512" />');
    expect(mark).not.toContain("next/image");
    for (const old of ["lantern-bloom", "lantern-halo", "lantern-core", "lantern-eyes"]) {
      expect(mark).not.toContain(old);
    }
  });

  it("the burning eyes reuse the logo's brace paths and no other eye shapes exist", () => {
    const svg = read("public", "lazarus-logo.svg");
    for (const d of BRACES) {
      expect(svg, "brace path exists in the logo asset").toContain(d);
      expect(mark, "brace path is redrawn in the mark").toContain(d);
    }
    // Both braces are drawn twice (sharp stroke + blurred glow): once per group, via the constants.
    expect((mark.match(/<path d=\{BRACE_LEFT\} \/>/g) ?? []).length).toBe(2);
    expect((mark.match(/<path d=\{BRACE_RIGHT\} \/>/g) ?? []).length).toBe(2);
    expect(mark).not.toContain("<circle");
    // Every ellipse is a centred glow layer (cx 256); none sits left or right of centre like an eye.
    const ellipses = [...mark.matchAll(/<ellipse\b[^>]*>/g)].map((m) => m[0]);
    expect(ellipses.length).toBeGreaterThanOrEqual(4);
    for (const el of ellipses) {
      expect(/cx="(\d+)"/.exec(el)?.[1], el).toBe("256");
    }
  });

  it("the plain variant has only the bloom and halo; the lantern variant adds the rest", () => {
    const [plainPart, fullPart] = mark.split("<image href");
    expect(plainPart).toContain('className="lm-bloom"');
    expect(plainPart).toContain('className="lm-halo"');
    for (const cls of ["lm-rim", "lm-core", "lm-eyes", "lm-eye-glow", "lm-spill"]) {
      expect(plainPart).not.toContain(`className="${cls}"`);
      expect(fullPart).toContain(`className="${cls}"`);
    }
    expect(css).toMatch(/\.lantern\[data-variant="plain"\] \.lm-halo\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/\.lantern\[data-variant="plain"\] \.lm-bloom\s*\{[^}]*animation:\s*none/);
  });

  it("the header uses the plain mark and the hero uses the full lantern", () => {
    expect(read("app", "layout.tsx")).toMatch(/<LazarusMark\s[^>]*variant="plain"/);
    const hero = /<LazarusMark\s[^>]*>/.exec(read("app", "page.tsx"))?.[0] ?? "";
    expect(hero).not.toContain('variant="plain"');
    expect(Number(/size=\{(\d+)\}/.exec(hero)?.[1])).toBeGreaterThanOrEqual(128);
  });

  it("lantern layers never take pointer events and sit below text", () => {
    const lantern = topLevelRules(css).find((r) => r.selectors.includes(".lantern"));
    expect(lantern?.body).toMatch(/pointer-events:\s*none/);
    expect(lantern?.body).toMatch(/z-index:\s*-1/);
    const svg = topLevelRules(css).find((r) => r.selectors.includes(".lantern-svg"));
    expect(svg?.body).toMatch(/pointer-events:\s*none/);
    expect(svg?.body).toMatch(/overflow:\s*visible/);
    const layers = topLevelRules(css).find((r) => r.selectors.includes(".lm-bloom") && r.selectors.includes(".lm-eyes"));
    expect(layers?.body).toMatch(/pointer-events:\s*none/);
    expect(layers?.body).toMatch(/transform-box:\s*fill-box/);
  });

  it("the lm-* keyframes animate only opacity and transform, share 4.2 s (bloom 6.5 s), rim lags 90 ms", () => {
    const lm = keyframes.filter((k) => k.name.startsWith("lm-"));
    expect(lm.map((k) => k.name).sort()).toEqual(
      ["lm-bloom", "lm-core", "lm-eye-glow", "lm-eyes", "lm-halo", "lm-rim"],
    );
    for (const kf of lm) {
      const decls = [...kf.body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      expect(decls.length).toBeGreaterThan(0);
      for (const prop of decls) expect(["opacity", "transform"], `${kf.name} uses ${prop}`).toContain(prop);
    }
    const anim = (name: string): string =>
      topLevelRules(css).find((r) => r.selectors.length === 1 && r.selectors[0] === `.${name}`)?.body ?? "";
    for (const n of ["lm-halo", "lm-core", "lm-rim", "lm-eyes", "lm-eye-glow"]) {
      expect(anim(n), n).toMatch(new RegExp(`animation:\\s*${n}\\s+4\\.2s`));
    }
    expect(anim("lm-bloom")).toMatch(/animation:\s*lm-bloom\s+6\.5s/);
    expect(anim("lm-rim")).toMatch(/animation:\s*lm-rim\s+4\.2s\s+\S+\s+90ms/);
  });

  it("the halo keyframes never exceed the --halo-opacity peak that the contrast test budgets", () => {
    const body = keyframes.find((k) => k.name === "lm-halo")?.body ?? "";
    const opacities = [...body.matchAll(/opacity:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(opacities.length).toBeGreaterThan(3);
    for (const o of opacities) {
      const k = o === "var(--halo-opacity)" ? 1 : Number(/^calc\(var\(--halo-opacity\) \* ([\d.]+)\)$/.exec(o)?.[1]);
      expect(k, o).toBeGreaterThan(0);
      expect(k, o).toBeLessThanOrEqual(1);
    }
  });

  it("the pocket spill is clipped to the front-pocket shape", () => {
    expect(mark).toContain("M104 304 L256 392 L408 304 L408 444 Q408 464 388 464 L124 464 Q104 464 104 444 Z");
    expect(mark).toMatch(/<g clipPath=\{ref\("pocket"\)\}/);
  });

  it("the moon is a pale disc with light craters, bright only in the side gutter", () => {
    expect(css).toMatch(/--moon:\s*#e9e4f5;/);
    expect(css).toMatch(/\.moon-shade\s*\{\s*fill:\s*#[0-9a-f]{6};\s*opacity:\s*0\.3\d*;/);
    expect(css).not.toMatch(/\.moon-shade\s*\{[^}]*var\(--background\)/);
    const wide = css.indexOf("@media (min-width: 1400px)");
    expect(wide).toBeGreaterThanOrEqual(0);
    const body = blockAt(css, wide);
    expect(body).toMatch(/\.moon\s*\{[^}]*opacity:\s*var\(--moon-opacity-wide\)/);
    // 160 px wide + 4 px offset must fit beside the 64rem (1024 px) content column at 1400 px.
    const width = Number(/width:\s*(\d+)px/.exec(body)?.[1]);
    expect(width + 4).toBeLessThanOrEqual((1400 - 1024) / 2);
    expect(css).toMatch(/--moon-opacity-wide:\s*0\.85;/);
  });

  it("the graveyard fades into the page background with a bottom mask", () => {
    expect(read("components", "Graveyard.tsx")).toContain("graveyard-art");
    const rule = topLevelRules(css).find((r) => r.selectors.includes(".graveyard-art"));
    expect(rule?.body).toMatch(/mask-image:\s*linear-gradient\(to bottom,[^)]*transparent 100%\)/);
  });

  it("the SpiritAwakening scene svg is aria-hidden and the stage label is real text", () => {
    expect(scene).toMatch(/<svg\s[^>]*aria-hidden="true"/);
    expect(scene).toContain("{label}");
  });

  it("the stage text lives in an aria-live region in AwakeningRitual", () => {
    expect(read("components", "AwakeningRitual.tsx")).toMatch(
      /aria-live="polite"[^>]*>\s*\{ritualLabel\(kind, state\.stageIndex\)\}/,
    );
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
