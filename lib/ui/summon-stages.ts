import type { AwakeningStage } from "./awakening-state";

export type SummonKind = "summon" | "demo";

export const STAGE_DELAYS_MS = [1500, 3500] as const;

const LATER_STAGES = ["Reading the runes…", "Raising the spirits…"] as const;

/** Stage label for a given elapsed time since the request started. */
export function stageLabel(kind: SummonKind, elapsedMs: number): string {
  if (elapsedMs >= STAGE_DELAYS_MS[1]) return LATER_STAGES[1];
  if (elapsedMs >= STAGE_DELAYS_MS[0]) return LATER_STAGES[0];
  return kind === "demo" ? "Raising a sandbox…" : "Fetching the WSDL…";
}

/** Scene stage for the same elapsed time; follows the same thresholds as `stageLabel`. */
export function stageKey(kind: SummonKind, elapsedMs: number): AwakeningStage {
  if (elapsedMs >= STAGE_DELAYS_MS[1]) return "raising";
  if (elapsedMs >= STAGE_DELAYS_MS[0]) return "reading";
  return kind === "demo" ? "demo-sandbox" : "fetching";
}
