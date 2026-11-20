import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  HOLD_MS,
  reduce,
  type HoldEvent,
  type HoldState,
} from "../../lib/ui/hold-machine";

type Kind = "down" | "up" | "cancel" | "tick" | "sent" | "failed";

// Events with monotonically non-decreasing timestamps. Weighted so that
// down/tick dominate and deltas often span the 2000 ms threshold.
const eventsArb = fc
  .array(
    fc.record({
      kind: fc.constantFrom<Kind>(
        "down",
        "down",
        "tick",
        "tick",
        "tick",
        "up",
        "cancel",
        "sent",
        "failed",
      ),
      delta: fc.oneof(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 1200 }),
        fc.integer({ min: 1000, max: 2500 }),
      ),
    }),
    { minLength: 0, maxLength: 40 },
  )
  .map((items) => {
    let t = 0;
    return items.map(({ kind, delta }): HoldEvent => {
      t += delta;
      switch (kind) {
        case "down":
        case "up":
        case "tick":
          return { type: kind, at: t };
        case "cancel":
          return { type: "cancel" };
        case "sent":
          return { type: "sent" };
        case "failed":
          return { type: "failed", message: "x" };
      }
    });
  });

const IDLE: HoldState = { kind: "idle" };

describe("hold-machine properties", () => {
  it("Property 28: never sends before 2000 ms of continuous holding", () => {
    let sends = 0;
    fc.assert(
      fc.property(eventsArb, (events) => {
        let s: HoldState = IDLE;
        // Independent model: start of the current continuous down span
        // (first down since the last up/cancel or the last send).
        let holdStart: number | null = null;
        for (const e of events) {
          if (e.type === "up" || e.type === "cancel") {
            holdStart = null;
          } else if (e.type === "down" && holdStart === null) {
            holdStart = e.at;
          }
          const r = reduce(s, e);
          if (r.effect === "send") {
            sends++;
            expect(e.type).toBe("tick");
            expect(holdStart).not.toBeNull();
            if (e.type === "tick" && holdStart !== null) {
              expect(e.at - holdStart).toBeGreaterThanOrEqual(HOLD_MS);
            }
            holdStart = null;
          }
          s = r.state;
        }
      }),
      { numRuns: 500 },
    );
    expect(sends).toBeGreaterThan(0);
  });

  it("Property 29: at most one send per attempt; a failed attempt may be retried", () => {
    let sequencesWithSend = 0;
    fc.assert(
      fc.property(eventsArb, (events) => {
        let s: HoldState = IDLE;
        let total = 0;
        let perAttempt = 0;
        let released = false;
        for (const e of events) {
          const r = reduce(s, e);
          if (r.effect === "send") {
            total++;
            perAttempt++;
            expect(released).toBe(false);
            expect(perAttempt).toBeLessThanOrEqual(1);
          }
          if (e.type === "failed") perAttempt = 0;
          s = r.state;
          // "released" is terminal; a stray "sent" outside an in-flight send is ignored.
          if (s.kind === "released") released = true;
        }
        if (total > 0) sequencesWithSend++;
      }),
      { numRuns: 500 },
    );
    expect(sequencesWithSend).toBeGreaterThan(0);
  });

  it("retry after failure sends once more", () => {
    const events: HoldEvent[] = [
      { type: "down", at: 0 },
      { type: "tick", at: 2000 },
      { type: "failed", message: "x" },
      { type: "down", at: 3000 },
      { type: "down", at: 4000 },
      { type: "tick", at: 5000 },
    ];
    let s: HoldState = IDLE;
    const sendsAt: number[] = [];
    events.forEach((e, i) => {
      const r = reduce(s, e);
      if (r.effect === "send") sendsAt.push(i);
      s = r.state;
    });
    expect(sendsAt).toHaveLength(2);
    expect(sendsAt[0]).toBeLessThan(2);
    expect(sendsAt[1]).toBeGreaterThan(2);
  });

  it("Property 30: repeated down events cannot restart or shorten the hold", () => {
    let completions = 0;
    const arb = fc.record({
      t0: fc.integer({ min: 0, max: 10_000 }),
      steps: fc.array(
        fc.record({
          kind: fc.constantFrom<"down" | "tick">("down", "tick"),
          delta: fc.oneof(
            fc.integer({ min: 0, max: 300 }),
            fc.integer({ min: 0, max: 2500 }),
          ),
        }),
        { minLength: 1, maxLength: 40 },
      ),
    });
    fc.assert(
      fc.property(arb, ({ t0, steps }) => {
        let s: HoldState = reduce(IDLE, { type: "down", at: t0 }).state;
        expect(s).toEqual({ kind: "holding", startedAt: t0 });
        let t = t0;
        for (const step of steps) {
          t += step.delta;
          const r = reduce(s, { type: step.kind, at: t });
          if (r.effect === "send") {
            // First completion must be a tick at or after t0 + HOLD_MS.
            expect(step.kind).toBe("tick");
            expect(t).toBeGreaterThanOrEqual(t0 + HOLD_MS);
            completions++;
            break;
          }
          if (t >= t0 + HOLD_MS && step.kind === "tick") {
            throw new Error("tick at/after t0+HOLD_MS did not complete");
          }
          if (s.kind === "holding") {
            expect(r.state).toEqual({ kind: "holding", startedAt: t0 });
          }
          s = r.state;
        }
      }),
      { numRuns: 500 },
    );
    expect(completions).toBeGreaterThan(0);
  });
});

describe("hold-machine edge cases", () => {
  it("tick at exactly 2000 ms sends", () => {
    const h = reduce(IDLE, { type: "down", at: 100 }).state;
    const r = reduce(h, { type: "tick", at: 100 + HOLD_MS });
    expect(r.effect).toBe("send");
    expect(r.state).toEqual({ kind: "held-complete" });
  });

  it("tick at 1999 ms does not send", () => {
    const h = reduce(IDLE, { type: "down", at: 100 }).state;
    const r = reduce(h, { type: "tick", at: 100 + HOLD_MS - 1 });
    expect(r.effect).toBeUndefined();
    expect(r.state).toEqual({ kind: "holding", startedAt: 100 });
  });

  it("up at 1999 ms then down again restarts cleanly", () => {
    let s = reduce(IDLE, { type: "down", at: 0 }).state;
    s = reduce(s, { type: "up", at: 1999 }).state;
    expect(s).toEqual({ kind: "idle" });
    s = reduce(s, { type: "down", at: 2000 }).state;
    expect(s).toEqual({ kind: "holding", startedAt: 2000 });
    const early = reduce(s, { type: "tick", at: 2000 + HOLD_MS - 1 });
    expect(early.effect).toBeUndefined();
    const done = reduce(early.state, { type: "tick", at: 2000 + HOLD_MS });
    expect(done.effect).toBe("send");
  });
});
