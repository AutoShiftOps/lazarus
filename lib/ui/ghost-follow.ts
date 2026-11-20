/** Pure math for the ghost pointer follower. No DOM access. */

export interface Point {
  x: number;
  y: number;
}

export const DEFAULT_LAG_MS = 140;
export const MAX_DT_MS = 100;
export const SNAP_DISTANCE_PX = 0.3;
/** Horizontal speed (px per frame-step) below which the facing does not change. */
export const FACING_DEAD_ZONE = 0.5;

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/**
 * Moves `current` toward `target` with frame-rate independent exponential smoothing.
 * dt is clamped to 0..100 ms. Never overshoots; snaps when closer than 0.3 px.
 */
export function followStep(
  current: Point,
  target: Point,
  dtMs: number,
  lagMs: number = DEFAULT_LAG_MS,
): Point {
  const tx = finite(target.x, 0);
  const ty = finite(target.y, 0);
  const cx = finite(current.x, tx);
  const cy = finite(current.y, ty);
  const dt = Math.min(MAX_DT_MS, Math.max(0, finite(dtMs, 0)));
  const lag = finite(lagMs, DEFAULT_LAG_MS);
  const alpha = lag > 0 ? 1 - Math.exp(-dt / lag) : 1;
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.hypot(dx, dy) < SNAP_DISTANCE_PX) return { x: tx, y: ty };
  const next = { x: cx + dx * alpha, y: cy + dy * alpha };
  if (Math.hypot(tx - next.x, ty - next.y) < SNAP_DISTANCE_PX) return { x: tx, y: ty };
  return next;
}

/** Which way the ghost looks. Inside the dead zone it keeps `previous`. */
export function facing(vx: number, previous: "left" | "right" = "right"): "left" | "right" {
  if (!Number.isFinite(vx)) return previous;
  if (vx > FACING_DEAD_ZONE) return "right";
  if (vx < -FACING_DEAD_ZONE) return "left";
  return previous;
}
