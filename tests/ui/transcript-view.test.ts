import { describe, expect, it } from "vitest";
import {
  decisionLabel,
  formatDuration,
  formatTime,
  fourSteps,
  outcomeLabel,
} from "../../lib/ui/transcript-view";
import type { TranscriptItem } from "../../lib/ui/transcripts-client";

const base: TranscriptItem = {
  id: "t1",
  ts: "2026-01-01T10:20:30.000Z",
  tool: "GetBalance",
  args: { pin: "[redacted]", n: 1 },
  risk: "read",
  decision: "allow",
  outcome: "ok",
  durationMs: 12,
  summary: "done",
};

describe("transcript-view", () => {
  it("labels every decision with text and an icon", () => {
    expect(decisionLabel("allow").label).toBe("Allowed");
    expect(decisionLabel("hold").label).toBe("Held");
    expect(decisionLabel("block").label).toBe("Blocked");
    expect(decisionLabel("ghost").label).toBe("Ghost");
    for (const d of ["allow", "hold", "block", "ghost"] as const) {
      expect(decisionLabel(d).icon).not.toBe("");
    }
  });

  it("labels every outcome", () => {
    for (const o of ["ok", "fault", "error", "held", "blocked", "ghost"] as const) {
      expect(outcomeLabel(o)).not.toBe("");
    }
    expect(outcomeLabel("fault")).toBe("SOAP fault");
  });

  it("formats duration and time", () => {
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(-1)).toBe("—");
    expect(formatTime(base.ts)).toBe("10:20:30");
    expect(formatTime("nope")).toBe("—");
  });

  it("builds four steps and shows Not sent for absent SOAP", () => {
    const steps = fourSteps(base);
    expect(steps.map((s) => s.title)).toEqual(["JSON in", "SOAP request", "SOAP response", "JSON out"]);
    expect(steps[1].body).toBe("Not sent");
    expect(steps[2].body).toBe("Not sent");
    expect(steps[3].body).toBe("Summary: done");
  });

  it("keeps [redacted] and uses SOAP fields when present", () => {
    const steps = fourSteps({ ...base, soapRequest: "<a/>", soapResponse: "<b/>" });
    expect(steps[0].body).toContain('"pin": "[redacted]"');
    expect(steps[1].body).toBe("<a/>");
    expect(steps[2].body).toBe("<b/>");
  });

  it("truncates long bodies with an ellipsis", () => {
    const steps = fourSteps({ ...base, soapRequest: "x".repeat(5000) });
    expect(steps[1].body).toBe(`${"x".repeat(4000)}…`);
  });
});
