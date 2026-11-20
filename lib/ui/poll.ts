import { useEffect, useRef } from "react";

export type Cancel = () => void;

export interface PollerOptions {
  fn: (signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  backoffMs?: number;
  backoffAfter?: number;
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => Cancel;
  isHidden?: () => boolean;
}

export interface Poller {
  start: () => void;
  stop: () => void;
  /** Call when document visibility changes. */
  notifyVisibility: () => void;
  /** Timestamp (from `now`) of the last settled run, or null. */
  lastSettledAt: () => number | null;
}

const defaultSchedule = (cb: () => void, ms: number): Cancel => {
  const id = setTimeout(cb, ms);
  return () => clearTimeout(id);
};

const defaultIsHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

export function createPoller(options: PollerOptions): Poller {
  const {
    fn,
    intervalMs = 2000,
    backoffMs = 10000,
    backoffAfter = 3,
    now = Date.now,
    schedule = defaultSchedule,
    isHidden = defaultIsHidden,
  } = options;

  let running = false;
  let inFlight = false;
  let cancelTimer: Cancel | null = null;
  let controller: AbortController | null = null;
  let failures = 0;
  let settledAt: number | null = null;

  const clearTimer = (): void => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  };

  const scheduleNext = (): void => {
    clearTimer();
    const delay = failures >= backoffAfter ? backoffMs : intervalMs;
    cancelTimer = schedule(tick, delay);
  };

  const run = async (): Promise<void> => {
    inFlight = true;
    const own = new AbortController();
    controller = own;
    try {
      await fn(own.signal);
      failures = 0;
    } catch {
      if (!own.signal.aborted) failures += 1;
    } finally {
      inFlight = false;
      settledAt = now();
      if (controller === own) controller = null;
    }
    if (running) scheduleNext();
  };

  function tick(): void {
    cancelTimer = null;
    if (!running || inFlight) return;
    if (isHidden()) return; // paused until notifyVisibility()
    void run();
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      tick();
    },
    stop() {
      running = false;
      clearTimer();
      controller?.abort();
      controller = null;
    },
    notifyVisibility() {
      if (!running) return;
      if (isHidden()) {
        clearTimer();
      } else if (!cancelTimer && !inFlight) {
        tick();
      }
    },
    lastSettledAt: () => settledAt,
  };
}

export function usePolling(
  fn: (signal: AbortSignal) => Promise<void>,
  intervalMs = 2000,
): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    const poller = createPoller({
      fn: (signal) => fnRef.current(signal),
      intervalMs,
    });
    const onVisibility = (): void => poller.notifyVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
    };
  }, [intervalMs]);
}
