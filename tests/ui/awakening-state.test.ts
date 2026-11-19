import { describe, expect, it } from "vitest";
import { awakeningState, RUNE_COUNT } from "../../lib/ui/awakening-state";
import { STAGE_DELAYS_MS, stageKey } from "../../lib/ui/summon-stages";

describe("awakeningState", () => {
  it("fetching: eyes closed, spirit buried, no runes", () => {
    expect(awakeningState("fetching")).toEqual({ eyes: "closed", spirit: "buried", runes: 0, glow: 0.2 });
  });

  it("demo-sandbox looks like fetching", () => {
    expect(awakeningState("demo-sandbox")).toEqual(awakeningState("fetching"));
  });

  it("reading: eyes dim, runes lit, spirit still buried", () => {
    expect(awakeningState("reading")).toEqual({ eyes: "dim", spirit: "buried", runes: RUNE_COUNT, glow: 0.5 });
  });

  it("raising: eyes blazing, spirit rising, full glow", () => {
    expect(awakeningState("raising")).toEqual({ eyes: "blazing", spirit: "rising", runes: RUNE_COUNT, glow: 1 });
  });

  it("stirring: eyes blazing, spirit still buried, between reading and raising", () => {
    expect(awakeningState("stirring")).toEqual({ eyes: "blazing", spirit: "buried", runes: RUNE_COUNT, glow: 0.75 });
  });

  it("an unknown stage defaults to the earliest state", () => {
    for (const s of ["", "nonsense", "toString", "__proto__"]) {
      expect(awakeningState(s)).toEqual(awakeningState("fetching"));
    }
  });

  it("glow only grows as the stages advance", () => {
    expect(awakeningState("fetching").glow).toBeLessThan(awakeningState("reading").glow);
    expect(awakeningState("reading").glow).toBeLessThan(awakeningState("raising").glow);
  });

  it("returns a fresh object so callers cannot corrupt the table", () => {
    const a = awakeningState("raising");
    a.runes = 99;
    expect(awakeningState("raising").runes).toBe(RUNE_COUNT);
  });
});

describe("stageKey", () => {
  it("follows the same thresholds as stageLabel", () => {
    expect(stageKey("summon", 0)).toBe("fetching");
    expect(stageKey("demo", 0)).toBe("demo-sandbox");
    expect(stageKey("summon", STAGE_DELAYS_MS[0] - 1)).toBe("fetching");
    expect(stageKey("summon", STAGE_DELAYS_MS[0])).toBe("reading");
    expect(stageKey("demo", STAGE_DELAYS_MS[1] - 1)).toBe("reading");
    expect(stageKey("demo", STAGE_DELAYS_MS[1])).toBe("raising");
  });
});
