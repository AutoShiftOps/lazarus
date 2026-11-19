/** What the "spirit waking" scene shows at each summon stage. Pure, so it can be unit-tested. */

export type AwakeningStage = "fetching" | "reading" | "stirring" | "raising" | "demo-sandbox";

export interface AwakeningState {
  eyes: "closed" | "dim" | "blazing";
  spirit: "buried" | "rising";
  /** How many of the RUNE_COUNT runes glow. */
  runes: number;
  /** Halo strength from 0 to 1. */
  glow: number;
}

export const RUNE_COUNT = 5;

const BURIED: AwakeningState = { eyes: "closed", spirit: "buried", runes: 0, glow: 0.2 };

const STATES: Record<AwakeningStage, AwakeningState> = {
  fetching: BURIED,
  "demo-sandbox": BURIED,
  reading: { eyes: "dim", spirit: "buried", runes: RUNE_COUNT, glow: 0.5 },
  stirring: { eyes: "blazing", spirit: "buried", runes: RUNE_COUNT, glow: 0.75 },
  raising: { eyes: "blazing", spirit: "rising", runes: RUNE_COUNT, glow: 1 },
};

/** Unknown stages fall back to the earliest state (grave still buried, eyes closed). */
export function awakeningState(stage: string): AwakeningState {
  return Object.hasOwn(STATES, stage) ? { ...STATES[stage as AwakeningStage] } : { ...BURIED };
}
