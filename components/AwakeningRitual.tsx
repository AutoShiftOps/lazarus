"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ritualLabel,
  ritualSceneStage,
  ritualState,
  type SummonStatus,
} from "../lib/ui/ritual-timing";
import type { SummonKind } from "../lib/ui/summon-stages";
import { SpiritAwakening } from "./SpiritAwakening";

const TICK_MS = 100;

const subscribeNever = (): (() => void) => () => {};

/** False on the server and during hydration, true on the client afterwards (no hydration mismatch). */
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

interface Props {
  kind: SummonKind;
  summonStatus: SummonStatus;
  /** The summon succeeded and the awake moment has been held: navigate now. */
  onDone: () => void;
  /** The summon failed: the overlay asks to be closed at once. */
  onClosed: () => void;
}

/** Reduced motion or Still mode (the `data-still` attribute is the source of truth for Still). */
function detectReduced(): boolean {
  if (typeof window === "undefined") return false;
  const still = document.documentElement.getAttribute("data-still") === "true";
  const media = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return still || media;
}

/**
 * Full-screen "spirit waking" ritual. A fixed overlay above the page, centred in the viewport and
 * independent of scroll. The stage text in the aria-live region is the source of truth; the scene
 * is decorative. Timing comes from the pure `ritualState`.
 */
export function AwakeningRitual({ kind, summonStatus, onDone, onClosed }: Props) {
  const mounted = useMounted();
  const [reduced] = useState(detectReduced);
  const [skipped, setSkipped] = useState(false);
  const [clock, setClock] = useState<{ elapsedMs: number; settledAtMs: number | undefined }>({
    elapsedMs: 0,
    settledAtMs: undefined,
  });
  const skipRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<SummonStatus>(summonStatus);
  const doneRef = useRef(onDone);
  const closedRef = useRef(onClosed);
  const firedRef = useRef(false);

  useEffect(() => {
    statusRef.current = summonStatus;
    doneRef.current = onDone;
    closedRef.current = onClosed;
  });

  // Clock: one interval, cleared on unmount.
  useEffect(() => {
    const startedAt = performance.now();
    const id = setInterval(() => {
      const elapsedMs = performance.now() - startedAt;
      setClock((prev) => ({
        elapsedMs,
        settledAtMs: prev.settledAtMs ?? (statusRef.current === "pending" ? undefined : elapsedMs),
      }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Lock body scroll while open, restore on close.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Move focus into the overlay, give it back on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!mounted) return;
    skipRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, [mounted]);

  const state = ritualState({
    elapsedMs: clock.elapsedMs,
    summonStatus,
    skipped,
    reduced,
    settledAtMs: clock.settledAtMs,
  });

  useEffect(() => {
    if (firedRef.current) return;
    if (state.phase === "done") {
      firedRef.current = true;
      doneRef.current();
    } else if (state.phase === "closed") {
      firedRef.current = true;
      closedRef.current();
    }
  }, [state.phase]);

  // The Skip button is the only control: keep Tab inside the overlay.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Tab") {
      e.preventDefault();
      skipRef.current?.focus();
    }
  }

  if (!mounted || typeof document === "undefined") return null;

  // Portalled to <body>: the page container is transformed (animated), which would turn a fixed
  // overlay into one that only covers its own column.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Raising a spirit"
      onKeyDown={onKeyDown}
      className="ritual fixed inset-0 z-[1000] flex h-dvh w-screen flex-col items-center justify-center gap-4 overflow-hidden bg-background px-4"
    >
      <div aria-hidden="true" className={`w-full ${state.pulseLast ? "ritual-pulse" : ""}`}>
        <SpiritAwakening stage={ritualSceneStage(kind, state.stageIndex)} />
      </div>
      <div aria-live="polite" className="min-h-8 text-center font-display text-xl text-spectral">
        {ritualLabel(kind, state.stageIndex)}
      </div>
      <button
        ref={skipRef}
        type="button"
        onClick={() => setSkipped(true)}
        className="min-h-11 rounded-md border border-border bg-surface px-5 py-2 text-text hover:border-spectral"
      >
        Skip
      </button>
    </div>,
    document.body,
  );
}
