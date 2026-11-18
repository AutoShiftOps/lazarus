export const HOLD_MS = 2000;

export type HoldState =
  | { kind: "idle" }
  | { kind: "holding"; startedAt: number }
  | { kind: "held-complete" } // hold finished, approve request in flight
  | { kind: "released" } // approve sent
  | { kind: "error"; message: string };

export type HoldEvent =
  | { type: "down"; at: number }
  | { type: "up"; at: number }
  | { type: "cancel" } // pointer leave / blur / pointercancel
  | { type: "tick"; at: number }
  | { type: "sent" }
  | { type: "failed"; message: string };

export interface HoldResult {
  state: HoldState;
  effect?: "send";
}

export function reduce(s: HoldState, e: HoldEvent): HoldResult {
  switch (s.kind) {
    case "idle":
    case "error":
      if (e.type === "down") {
        return { state: { kind: "holding", startedAt: e.at } };
      }
      return { state: s };
    case "holding":
      if (e.type === "up" || e.type === "cancel") {
        return { state: { kind: "idle" } };
      }
      if (e.type === "tick" && e.at - s.startedAt >= HOLD_MS) {
        return { state: { kind: "held-complete" }, effect: "send" };
      }
      return { state: s };
    case "held-complete":
      if (e.type === "sent") return { state: { kind: "released" } };
      if (e.type === "failed") {
        return { state: { kind: "error", message: e.message } };
      }
      return { state: s };
    case "released":
      return { state: s };
  }
}
