"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { HOLD_MS, reduce, type HoldEvent, type HoldState } from "../lib/ui/hold-machine";

const TICK_MS = 50;
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

interface Props {
  /** Called exactly once when the 2000 ms hold completes. The caller does the API request. */
  onRelease: () => Promise<void> | void;
  disabled?: boolean;
  label?: string;
}

function isHoldKey(key: string): boolean {
  return key === " " || key === "Enter" || key === "Spacebar";
}

/** Reduced motion or Still mode (the `data-still` attribute is the source of truth for Still). */
function readReduced(): boolean {
  if (typeof window === "undefined") return false;
  const still = document.documentElement.getAttribute("data-still") === "true";
  const media = typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
  return still || media;
}

function subscribeReduced(onChange: () => void): () => void {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_QUERY) : null;
  media?.addEventListener?.("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-still"] });
  return () => {
    media?.removeEventListener?.("change", onChange);
    observer.disconnect();
  };
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

/**
 * Press-and-hold control that releases after 2000 ms. It drives the pure hold machine and never
 * calls the API itself: the parent supplies `onRelease`.
 */
export function CandleHold({ onRelease, disabled = false, label = "Hold to release" }: Props) {
  const helpId = useId();
  const reduced = useReducedMotion();
  const [state, setState] = useState<HoldState>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const stateRef = useRef<HoldState>(state);
  const sentRef = useRef(false);
  const releaseRef = useRef(onRelease);
  const keyHeldRef = useRef(false);

  useEffect(() => {
    releaseRef.current = onRelease;
  });

  const apply = useCallback((event: HoldEvent) => {
    const result = reduce(stateRef.current, event);
    stateRef.current = result.state;
    setState(result.state);
    return result.effect;
  }, []);

  const dispatch = useCallback(
    (event: HoldEvent) => {
      if (apply(event) !== "send" || sentRef.current) return;
      sentRef.current = true;
      void (async () => {
        try {
          await releaseRef.current();
          apply({ type: "sent" });
        } catch (error) {
          sentRef.current = false;
          apply({
            type: "failed",
            message: error instanceof Error && error.message ? error.message : "Could not release this call.",
          });
        }
      })();
    },
    [apply],
  );

  const holding = state.kind === "holding";

  // Timer: only while holding, cleared on unmount and when the hold ends.
  useEffect(() => {
    if (!holding) return;
    const id = setInterval(() => {
      const at = performance.now();
      setNow(at);
      dispatch({ type: "tick", at });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [holding, dispatch]);

  const inert = disabled || state.kind === "released" || state.kind === "held-complete";

  function start(): void {
    if (inert) return;
    const at = performance.now();
    setNow(at);
    dispatch({ type: "down", at });
  }

  function stop(type: "up" | "cancel"): void {
    keyHeldRef.current = false;
    dispatch(type === "up" ? { type: "up", at: performance.now() } : { type: "cancel" });
  }

  function onPointerDown(e: PointerEvent<HTMLButtonElement>): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort.
    }
    start();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (!isHoldKey(e.key)) return;
    e.preventDefault();
    if (e.repeat || keyHeldRef.current) return;
    keyHeldRef.current = true;
    start();
  }

  function onKeyUp(e: KeyboardEvent<HTMLButtonElement>): void {
    if (!isHoldKey(e.key)) return;
    e.preventDefault();
    if (keyHeldRef.current) stop("up");
  }

  const startedAt = state.kind === "holding" ? state.startedAt : 0;
  const elapsed = state.kind === "holding" ? Math.max(0, now - startedAt) : 0;
  const progress =
    state.kind === "released" || state.kind === "held-complete" ? 1 : Math.min(1, elapsed / HOLD_MS);
  const remaining = (Math.max(0, HOLD_MS - elapsed) / 1000).toFixed(1);
  const showCountdown = reduced && holding;

  return (
    <div className="candle-hold">
      <button
        type="button"
        aria-label="Hold to release"
        aria-describedby={helpId}
        disabled={inert}
        data-holding={holding ? "true" : "false"}
        data-reduced={reduced ? "true" : "false"}
        className="candle-hold-button"
        style={{ "--hold": progress } as React.CSSProperties}
        onPointerDown={onPointerDown}
        onPointerUp={() => stop("up")}
        onPointerLeave={() => stop("cancel")}
        onPointerCancel={() => stop("cancel")}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => stop("cancel")}
        onContextMenu={(e: MouseEvent<HTMLButtonElement>) => e.preventDefault()}
      >
        <span className="candle-hold-ring" aria-hidden="true" />
        <span className="candle-hold-flame" aria-hidden="true" />
        <span className="candle-hold-text" aria-hidden="true">
          {state.kind === "released" ? "Released" : showCountdown ? `Hold… ${remaining} s` : label}
        </span>
      </button>
      <p id={helpId} className="candle-hold-help">
        Hold Space or Enter, or press and hold, for 2 seconds
      </p>
      <p role="status" aria-live="polite" className="candle-hold-status">
        {state.kind === "released" ? "Released" : state.kind === "error" ? state.message : ""}
      </p>
    </div>
  );
}
