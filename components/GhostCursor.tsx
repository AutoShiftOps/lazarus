"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { facing, followStep, type Point } from "../lib/ui/ghost-follow";

/**
 * Small decorative ghost that trails the mouse pointer. Active only for fine hovering pointers,
 * without reduced motion and outside Still mode. Position is written as translate3d in a single
 * requestAnimationFrame loop that runs only while the ghost is moving. Never interactive.
 */

const QUERIES = ["(pointer: fine)", "(hover: hover)"] as const;
const REDUCED = "(prefers-reduced-motion: reduce)";
const OFFSET = 18;
const OPACITY = 0.9;
const OPACITY_HOLDING = 0.25;

function readActive(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return (
    QUERIES.every((q) => window.matchMedia(q).matches) &&
    !window.matchMedia(REDUCED).matches &&
    document.documentElement.dataset.still !== "true"
  );
}

function subscribeActive(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = [...QUERIES, REDUCED].map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-still"] });
  return () => {
    for (const l of lists) l.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

export function GhostCursor() {
  const active = useSyncExternalStore(subscribeActive, readActive, () => false);
  if (!active) return null;
  return <Ghost />;
}

function Ghost() {
  const rootRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const flip = flipRef.current;
    const eyes = eyesRef.current;
    if (!root || !flip || !eyes) return;

    let pos: Point | null = null;
    let target: Point = { x: 0, y: 0 };
    let dir: "left" | "right" = "right";
    let visible = false;
    let holding = false;
    let raf = 0;
    let last = 0;

    const paintOpacity = (): void => {
      root.style.opacity = !visible ? "0" : String(holding ? OPACITY_HOLDING : OPACITY);
    };
    const paintDir = (): void => {
      flip.style.transform = dir === "left" ? "scaleX(-1)" : "scaleX(1)";
      eyes.style.transform = "translate(-1px, -1px)";
    };
    const paintPos = (p: Point): void => {
      root.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    };

    const frame = (now: number): void => {
      raf = 0;
      if (!pos) return;
      const dt = last ? now - last : 16;
      last = now;
      const next = followStep(pos, target, dt);
      const nextDir = facing(next.x - pos.x, dir);
      if (nextDir !== dir) {
        dir = nextDir;
        paintDir();
      }
      pos = next;
      paintPos(pos);
      if (pos.x !== target.x || pos.y !== target.y) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    const kick = (): void => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") {
        visible = false;
        paintOpacity();
        return;
      }
      target = { x: e.clientX + OFFSET, y: e.clientY + OFFSET };
      if (!pos) {
        pos = target;
        paintPos(pos);
      }
      if (!visible) {
        visible = true;
        paintOpacity();
      }
      kick();
    };
    const onTouch = (e: PointerEvent): void => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        visible = false;
        paintOpacity();
      }
    };
    const onLeave = (): void => {
      visible = false;
      paintOpacity();
    };

    const syncHolding = (): void => {
      holding = document.querySelector('[data-holding="true"]') !== null;
      paintOpacity();
    };
    const observer = new MutationObserver(syncHolding);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-holding"],
    });

    paintDir();
    paintOpacity();
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onTouch, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onTouch);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-testid="ghost-cursor"
      className="ghost-cursor pointer-events-none fixed left-0 top-0 z-[100] h-[28px] w-[28px]"
      style={{ opacity: 0 }}
    >
      <div ref={flipRef} className="h-full w-full">
        <div className="ghost-bob h-full w-full">
          <svg viewBox="0 0 28 32" width="28" height="28" focusable="false" overflow="visible">
            <defs>
              <radialGradient id="ghost-glow">
                <stop offset="0%" stopColor="#4fd1c5" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#4fd1c5" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="14" cy="16" r="20" fill="url(#ghost-glow)" />
            <path
              d="M3 28 V13 C3 6 8 2 14 2 C20 2 25 6 25 13 V28 q-2.75 3 -5.5 0 t-5.5 0 t-5.5 0 t-5.5 0 Z"
              fill="#4fd1c5"
              fillOpacity="0.85"
            />
            <g ref={eyesRef} fill="#0b0812">
              <ellipse cx="10" cy="13" rx="2" ry="2.6" />
              <ellipse cx="18" cy="13" rx="2" ry="2.6" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
