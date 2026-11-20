import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { facing, followStep } from "../../lib/ui/ghost-follow";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("followStep", () => {
  it("converges to the target", () => {
    let p = { x: 0, y: 0 };
    const target = { x: 300, y: -200 };
    for (let i = 0; i < 200; i++) p = followStep(p, target, 16);
    expect(p).toEqual(target);
  });

  it("never overshoots on a straight path", () => {
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 100; i++) {
      p = followStep(p, { x: 100, y: 0 }, 16);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.x).toBeGreaterThanOrEqual(0);
    }
  });

  it("is frame-rate independent within tolerance", () => {
    const target = { x: 400, y: 100 };
    let a = { x: 0, y: 0 };
    let b = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) a = followStep(a, target, 16);
    for (let i = 0; i < 20; i++) b = followStep(b, target, 8);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  });

  it("snaps when closer than 0.3 px", () => {
    expect(followStep({ x: 10, y: 10 }, { x: 10.2, y: 10 }, 16)).toEqual({ x: 10.2, y: 10 });
  });

  it("clamps dt to 100 ms", () => {
    const a = followStep({ x: 0, y: 0 }, { x: 100, y: 0 }, 100);
    expect(followStep({ x: 0, y: 0 }, { x: 100, y: 0 }, 5000)).toEqual(a);
  });

  it("never returns NaN, even for odd inputs", () => {
    for (const dt of [0, -5, Number.NaN, Infinity, 1e9]) {
      const p = followStep({ x: 1, y: 2 }, { x: 3, y: 4 }, dt);
      expect(Number.isNaN(p.x) || Number.isNaN(p.y)).toBe(false);
    }
    const q = followStep({ x: Number.NaN, y: 0 }, { x: 3, y: 4 }, 16, 0);
    expect(Number.isNaN(q.x) || Number.isNaN(q.y)).toBe(false);
  });

  it("property: distance to target never increases", () => {
    const coord = fc.double({ min: -1e5, max: 1e5, noNaN: true });
    fc.assert(
      fc.property(coord, coord, coord, coord, fc.double({ min: 0, max: 500, noNaN: true }), (cx, cy, tx, ty, dt) => {
        const cur = { x: cx, y: cy };
        const target = { x: tx, y: ty };
        const next = followStep(cur, target, dt);
        expect(Number.isNaN(next.x) || Number.isNaN(next.y)).toBe(false);
        expect(dist(next, target)).toBeLessThanOrEqual(dist(cur, target) + 1e-9);
      }),
    );
  });
});

describe("facing", () => {
  it("turns with clear motion", () => {
    expect(facing(5)).toBe("right");
    expect(facing(-5)).toBe("left");
  });

  it("keeps the previous direction inside the dead zone", () => {
    expect(facing(0.2, "left")).toBe("left");
    expect(facing(-0.2, "right")).toBe("right");
    expect(facing(0)).toBe("right");
  });
});
