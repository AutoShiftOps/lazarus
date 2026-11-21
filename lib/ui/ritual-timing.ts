import type { AwakeningStage } from "./awakening-state";
import type { SummonKind } from "./summon-stages";

/** Pure timing for the full-screen awakening ritual. No React and no timers: callers feed it the clock. */

export type SummonStatus = "pending" | "success" | "failed";
export type RitualPhase = "running" | "awake-hold" | "done" | "closed";

/** Stage indexes: 0 fetching, 1 reading the runes, 2 raising spirits, 3 awake. */
export const AWAKE_INDEX = 3;
const LAST_WORKING_INDEX = 2;

export const STAGE_MIN_MS = 1400;
export const STAGE_MIN_REDUCED_MS = 600;
export const AWAKE_HOLD_MS = 3000;
export const AWAKE_HOLD_REDUCED_MS = 500;

export interface RitualInput {
  /** Milliseconds since the ritual started. */
  elapsedMs: number;
  summonStatus: SummonStatus;
  /** True once the visitor pressed Skip. */
  skipped: boolean;
  /** Reduced motion or Still mode: shorter minimums. */
  reduced: boolean;
  /** Elapsed time at which the summon settled. Only matters for "success"; defaults to 0. */
  settledAtMs?: number;
}

export interface RitualState {
  stageIndex: number;
  phase: RitualPhase;
  /** True while the summon is still pending after the last working stage (or after Skip). */
  pulseLast: boolean;
}

export function ritualTimings(reduced: boolean): { stageMs: number; holdMs: number } {
  return reduced
    ? { stageMs: STAGE_MIN_REDUCED_MS, holdMs: AWAKE_HOLD_REDUCED_MS }
    : { stageMs: STAGE_MIN_MS, holdMs: AWAKE_HOLD_MS };
}

export function ritualState(input: RitualInput): RitualState {
  const { stageMs, holdMs } = ritualTimings(input.reduced);
  const elapsed = Math.max(0, input.elapsedMs);
  const workingEnd = stageMs * (LAST_WORKING_INDEX + 1);
  const natural = Math.min(Math.floor(elapsed / stageMs), LAST_WORKING_INDEX);

  if (input.summonStatus === "failed") {
    return { stageIndex: input.skipped ? LAST_WORKING_INDEX : natural, phase: "closed", pulseLast: false };
  }

  if (input.summonStatus === "pending") {
    const stageIndex = input.skipped ? LAST_WORKING_INDEX : natural;
    const pulseLast = input.skipped || elapsed >= workingEnd;
    return { stageIndex, phase: "running", pulseLast };
  }

  // success
  if (input.skipped) {
    return { stageIndex: AWAKE_INDEX, phase: "done", pulseLast: false };
  }
  const awakeStart = Math.max(workingEnd, input.settledAtMs ?? 0);
  if (elapsed < awakeStart) {
    return { stageIndex: natural, phase: "running", pulseLast: false };
  }
  return {
    stageIndex: AWAKE_INDEX,
    phase: elapsed >= awakeStart + holdMs ? "done" : "awake-hold",
    pulseLast: false,
  };
}

export function ritualLabel(kind: SummonKind, stageIndex: number): string {
  if (stageIndex >= AWAKE_INDEX) return "The spirit is awake.";
  if (stageIndex === 2) return "Raising the spirits…";
  if (stageIndex === 1) return "Reading the runes…";
  return kind === "demo" ? "Raising a sandbox…" : "Fetching the WSDL…";
}

export function ritualSceneStage(kind: SummonKind, stageIndex: number): AwakeningStage {
  if (stageIndex >= AWAKE_INDEX) return "raising";
  if (stageIndex === 2) return "stirring";
  if (stageIndex === 1) return "reading";
  return kind === "demo" ? "demo-sandbox" : "fetching";
}
