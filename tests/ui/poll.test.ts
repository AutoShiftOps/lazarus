import { describe, expect, it } from "vitest";
import { createPoller } from "../../lib/ui/poll";

interface Timer {
  cb: () => void;
  ms: number;
  cancelled: boolean;
}

function harness() {
  const timers: Timer[] = [];
  let clock = 0;
  let hidden = false;
  const schedule = (cb: () => void, ms: number) => {
    const t: Timer = { cb, ms, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const pending = () => timers.filter((t) => !t.cancelled);
  const fireNext = (): number => {
    const t = pending()[0];
    if (!t) throw new Error("no pending timer");
    t.cancelled = true;
    clock += t.ms;
    t.cb();
    return t.ms;
  };
  return {
    schedule,
    pending,
    fireNext,
    now: () => clock,
    isHidden: () => hidden,
    setHidden: (v: boolean) => {
      hidden = v;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createPoller", () => {
  it("never overlaps requests: next run is scheduled only after settle", async () => {
    const h = harness();
    let calls = 0;
    let release: () => void = () => {};
    const poller = createPoller({
      fn: () => {
        calls++;
        return new Promise<void>((r) => {
          release = r;
        });
      },
      ...h,
    });
    poller.start();
    expect(calls).toBe(1);
    expect(h.pending()).toHaveLength(0);
    h.setHidden(false);
    poller.notifyVisibility();
    expect(calls).toBe(1);
    release();
    await flush();
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0].ms).toBe(2000);
    expect(poller.lastSettledAt()).toBe(0);
    poller.stop();
  });

  it("pauses while hidden and resumes on visible", async () => {
    const h = harness();
    let calls = 0;
    const poller = createPoller({
      fn: async () => {
        calls++;
      },
      ...h,
    });
    poller.start();
    await flush();
    expect(calls).toBe(1);
    h.setHidden(true);
    poller.notifyVisibility();
    expect(h.pending()).toHaveLength(0);
    expect(calls).toBe(1);
    h.setHidden(false);
    poller.notifyVisibility();
    await flush();
    expect(calls).toBe(2);
    expect(h.pending()).toHaveLength(1);
    poller.stop();
  });

  it("does not run when the timer fires while hidden", async () => {
    const h = harness();
    let calls = 0;
    const poller = createPoller({
      fn: async () => {
        calls++;
      },
      ...h,
    });
    poller.start();
    await flush();
    h.setHidden(true);
    h.fireNext();
    await flush();
    expect(calls).toBe(1);
    expect(h.pending()).toHaveLength(0);
    h.setHidden(false);
    poller.notifyVisibility();
    await flush();
    expect(calls).toBe(2);
    poller.stop();
  });

  it("backs off after 3 consecutive errors and recovers on success", async () => {
    const h = harness();
    let fail = true;
    const poller = createPoller({
      fn: async () => {
        if (fail) throw new Error("boom");
      },
      ...h,
    });
    poller.start();
    await flush();
    expect(h.pending()[0].ms).toBe(2000); // 1 error
    h.fireNext();
    await flush();
    expect(h.pending()[0].ms).toBe(2000); // 2 errors
    h.fireNext();
    await flush();
    expect(h.pending()[0].ms).toBe(10000); // 3 errors
    fail = false;
    h.fireNext();
    await flush();
    expect(h.pending()[0].ms).toBe(2000); // recovered
    poller.stop();
  });

  it("aborts the in-flight request on stop and clears timers", async () => {
    const h = harness();
    let captured: AbortSignal | null = null;
    let calls = 0;
    const poller = createPoller({
      fn: (signal) => {
        calls++;
        captured = signal;
        return new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      ...h,
    });
    poller.start();
    expect(captured).not.toBeNull();
    expect((captured as unknown as AbortSignal).aborted).toBe(false);
    poller.stop();
    expect((captured as unknown as AbortSignal).aborted).toBe(true);
    await flush();
    expect(h.pending()).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("stop() cancels a pending timer", async () => {
    const h = harness();
    const poller = createPoller({ fn: async () => {}, ...h });
    poller.start();
    await flush();
    expect(h.pending()).toHaveLength(1);
    poller.stop();
    expect(h.pending()).toHaveLength(0);
  });
});
