// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostCursor } from "../../components/GhostCursor";

function stubMedia(matching: (q: string) => boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: matching(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

const finePointer = (q: string): boolean => q.includes("pointer: fine") || q.includes("hover: hover");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-still");
});

describe("GhostCursor", () => {
  it("renders an aria-hidden, pointer-events-none, non-interactive element", () => {
    stubMedia(finePointer);
    const { getByTestId } = render(<GhostCursor />);
    const el = getByTestId("ghost-cursor");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.className).toContain("pointer-events-none");
    expect(el.querySelectorAll("a, button, input, select, textarea, [tabindex]").length).toBe(0);
  });

  it("does not render when (pointer: fine) is false", () => {
    stubMedia(() => false);
    const { queryByTestId } = render(<GhostCursor />);
    expect(queryByTestId("ghost-cursor")).toBeNull();
  });

  it("does not render in Still mode", () => {
    stubMedia(finePointer);
    document.documentElement.dataset.still = "true";
    const { queryByTestId } = render(<GhostCursor />);
    expect(queryByTestId("ghost-cursor")).toBeNull();
  });

  it("removes every listener it added when unmounted", () => {
    stubMedia(finePointer);
    const added: string[] = [];
    const removed: string[] = [];
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const { unmount } = render(<GhostCursor />);
    const own = (ctx: unknown): boolean => ctx === document || ctx === document.documentElement;
    const names = ["pointermove", "pointerdown", "mouseleave"];
    const pick = (spy: typeof add): string[] =>
      spy.mock.calls
        .map((c, i) => [c[0], spy.mock.contexts[i]] as const)
        .filter(([t, ctx]) => names.includes(t) && own(ctx))
        .map(([t]) => t);
    added.push(...pick(add));
    unmount();
    removed.push(...pick(remove));
    expect(added.sort()).toEqual(["mouseleave", "pointerdown", "pointermove"]);
    expect(removed.sort()).toEqual(added);
  });
});

describe("ghost styles", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

  it("the bob keyframes and the ghost transition only touch transform and opacity", () => {
    const start = css.indexOf("@keyframes ghost-bob");
    const body = css.slice(css.indexOf("{", start), css.indexOf("}\n\n/*", start));
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(["transform"]).toContain(p);
    expect(css).toMatch(/\.ghost-cursor\s*\{\s*transition:\s*opacity\b/);
    const src = readFileSync(join(process.cwd(), "components", "GhostCursor.tsx"), "utf8");
    expect(src).not.toMatch(/style\.(left|top|width|height|margin)\b/);
    expect(src).not.toMatch(/getBoundingClientRect|offsetWidth|offsetHeight/);
  });
});
