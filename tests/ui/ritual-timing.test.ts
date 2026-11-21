import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { awakeningState } from "../../lib/ui/awakening-state";
import {
  AWAKE_HOLD_MS,
  AWAKE_HOLD_REDUCED_MS,
  AWAKE_INDEX,
  STAGE_MIN_MS,
  STAGE_MIN_REDUCED_MS,
  ritualLabel,
  ritualSceneStage,
  ritualState,
  type RitualInput,
  type SummonStatus,
} from "../../lib/ui/ritual-timing";

const base: RitualInput = { elapsedMs: 0, summonStatus: "pending", skipped: false, reduced: false };
const at = (over: Partial<RitualInput>): ReturnType<typeof ritualState> => ritualState({ ...base, ...over });

describe("ritualState", () => {
  it("shows each stage for at least 1.4 s", () => {
    expect(at({ elapsedMs: 0 }).stageIndex).toBe(0);
    expect(at({ elapsedMs: STAGE_MIN_MS - 1 }).stageIndex).toBe(0);
    expect(at({ elapsedMs: STAGE_MIN_MS }).stageIndex).toBe(1);
    expect(at({ elapsedMs: 2 * STAGE_MIN_MS - 1 }).stageIndex).toBe(1);
    expect(at({ elapsedMs: 2 * STAGE_MIN_MS }).stageIndex).toBe(2);
  });

  it("does not reach the awake moment before the stages are done, even if the summon succeeded", () => {
    const s = at({ elapsedMs: 3 * STAGE_MIN_MS - 1, summonStatus: "success", settledAtMs: 100 });
    expect(s).toEqual({ stageIndex: 2, phase: "running", pulseLast: false });
  });

  it("holds the awake moment for at least 3 s, then is done", () => {
    const start = 3 * STAGE_MIN_MS;
    const s = (elapsedMs: number) => at({ elapsedMs, summonStatus: "success", settledAtMs: 200 });
    expect(s(start)).toEqual({ stageIndex: AWAKE_INDEX, phase: "awake-hold", pulseLast: false });
    expect(s(start + AWAKE_HOLD_MS - 1).phase).toBe("awake-hold");
    expect(s(start + AWAKE_HOLD_MS).phase).toBe("done");
  });

  it("stays on the last stage with a pulse while the summon is slow", () => {
    const s = at({ elapsedMs: 60_000 });
    expect(s).toEqual({ stageIndex: 2, phase: "running", pulseLast: true });
    expect(at({ elapsedMs: 3 * STAGE_MIN_MS - 1 }).pulseLast).toBe(false);
  });

  it("starts the awake hold when a slow summon finally succeeds", () => {
    const settledAtMs = 10_000;
    const s = (elapsedMs: number) => at({ elapsedMs, summonStatus: "success", settledAtMs });
    expect(s(settledAtMs).phase).toBe("awake-hold");
    expect(s(settledAtMs + AWAKE_HOLD_MS - 1).phase).toBe("awake-hold");
    expect(s(settledAtMs + AWAKE_HOLD_MS).phase).toBe("done");
  });

  it("closes at once when the summon fails, at any time", () => {
    for (const elapsedMs of [0, 500, 4000, 60_000]) {
      expect(at({ elapsedMs, summonStatus: "failed" }).phase).toBe("closed");
    }
    expect(at({ elapsedMs: 100, summonStatus: "failed", skipped: true }).phase).toBe("closed");
  });

  it("Skip waits for the summon: never done while pending", () => {
    const s = at({ elapsedMs: 50, skipped: true });
    expect(s.phase).toBe("running");
    expect(s.pulseLast).toBe(true);
  });

  it("Skip jumps to the awake moment and finishes as soon as the summon succeeds", () => {
    expect(at({ elapsedMs: 50, skipped: true, summonStatus: "success", settledAtMs: 40 })).toEqual({
      stageIndex: AWAKE_INDEX,
      phase: "done",
      pulseLast: false,
    });
  });

  it("uses 0.6 s stages and a 0.5 s hold when reduced", () => {
    const r = (over: Partial<RitualInput>) => at({ reduced: true, ...over });
    expect(r({ elapsedMs: STAGE_MIN_REDUCED_MS - 1 }).stageIndex).toBe(0);
    expect(r({ elapsedMs: STAGE_MIN_REDUCED_MS }).stageIndex).toBe(1);
    const start = 3 * STAGE_MIN_REDUCED_MS;
    const ok = { summonStatus: "success" as const };
    expect(r({ elapsedMs: start, ...ok }).phase).toBe("awake-hold");
    expect(r({ elapsedMs: start + AWAKE_HOLD_REDUCED_MS - 1, ...ok }).phase).toBe("awake-hold");
    expect(r({ elapsedMs: start + AWAKE_HOLD_REDUCED_MS, ...ok }).phase).toBe("done");
  });

  it("negative elapsed time is treated as zero", () => {
    expect(at({ elapsedMs: -5 }).stageIndex).toBe(0);
  });

  it("labels and scene stages advance together and the four scenes differ", () => {
    expect([0, 1, 2, 3].map((i) => ritualLabel("summon", i))).toEqual([
      "Fetching the WSDL…",
      "Reading the runes…",
      "Raising the spirits…",
      "The spirit is awake.",
    ]);
    expect(ritualLabel("demo", 0)).toBe("Raising a sandbox…");
    const glows = [0, 1, 2, 3].map((i) => awakeningState(ritualSceneStage("summon", i)).glow);
    expect(new Set(glows).size).toBe(4);
    expect(glows).toEqual([...glows].sort((a, b) => a - b));
  });

  it("property: phase is never done unless the summon succeeded", () => {
    // **Validates: Requirements 1.7**
    const status = fc.constantFrom<SummonStatus>("pending", "success", "failed");
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 200_000 }),
        status,
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 200_000 }),
        (elapsedMs, summonStatus, skipped, reduced, settledAtMs) => {
          const s = ritualState({ elapsedMs, summonStatus, skipped, reduced, settledAtMs });
          if (s.phase === "done") expect(summonStatus).toBe("success");
          if (summonStatus === "failed") expect(s.phase).toBe("closed");
        },
      ),
    );
  });
});
