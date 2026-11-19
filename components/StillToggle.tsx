"use client";

import { useSyncExternalStore } from "react";
import { browserStorage, setStill } from "../lib/ui/still-mode";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The `data-still` attribute (set by the head script and by this toggle) is the source of truth. */
function readStill(): boolean {
  return document.documentElement.getAttribute("data-still") === "true";
}

function readServerStill(): boolean {
  return false;
}

export function StillToggle() {
  const still = useSyncExternalStore(subscribe, readStill, readServerStill);

  function toggle(): void {
    const next = !readStill();
    if (next) document.documentElement.setAttribute("data-still", "true");
    else document.documentElement.removeAttribute("data-still");
    setStill(browserStorage(), next);
    for (const listener of listeners) listener();
  }

  return (
    <button
      type="button"
      aria-pressed={still}
      onClick={toggle}
      className="ml-auto min-h-11 shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text hover:border-spectral aria-pressed:border-candle aria-pressed:text-candle"
    >
      Still mode
    </button>
  );
}
