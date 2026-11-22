"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { getSettings, patchSettings } from "../lib/ui/settings-client";
import { getOwnerToken } from "../lib/ui/token-store";

export interface GhostState {
  /** null until the setting has loaded. */
  ghost: boolean | null;
  /** undefined = not read yet (server render and hydration), null = no token. Never rendered. */
  token: string | null | undefined;
  busy: boolean;
  error: string;
  toggle: () => void;
}

const GhostContext = createContext<GhostState | null>(null);

export function useGhost(): GhostState {
  const state = useContext(GhostContext);
  if (state === null) throw new Error("useGhost must be used inside GhostShell");
  return state;
}

const subscribeNever = (): (() => void) => () => undefined;

export const GHOST_BANNER_TEXT = "Ghost mode: nothing dangerous reaches the real service.";

/**
 * Owns the ghost-mode setting for the service page: loads it, applies the owner's toggle
 * (optimistic, rolled back on failure, one request at a time), shows the banner and tints the page.
 */
export function GhostShell({ serviceId, children }: { serviceId: string; children: ReactNode }) {
  const token = useSyncExternalStore(
    subscribeNever,
    () => getOwnerToken(serviceId),
    (): string | null | undefined => undefined,
  );
  const [ghost, setGhost] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void getSettings(serviceId, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setGhost(result.ghost);
      else setError(result.message);
    });
    return () => controller.abort();
  }, [serviceId]);

  const toggle = (): void => {
    if (inFlight.current || ghost === null || typeof token !== "string") return;
    inFlight.current = true;
    const previous = ghost;
    setGhost(!previous);
    setBusy(true);
    setError("");
    void patchSettings(serviceId, !previous, { ownerToken: token })
      .then((result) => {
        if (result.ok) {
          setGhost(result.ghost);
        } else {
          setGhost(previous);
          setError(result.message);
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <GhostContext.Provider value={{ ghost, token, busy, error, toggle }}>
      <div className={`ghost-shell space-y-12${ghost === true ? " ghost-tint" : ""}`}>
        {ghost === true ? (
          <p
            role="status"
            className="sticky top-0 z-20 flex items-center gap-2 rounded-md border border-spectral/50 bg-surface-raised px-4 py-2 text-sm text-text"
          >
            <span aria-hidden="true">👻</span>
            <span>{GHOST_BANNER_TEXT}</span>
          </p>
        ) : null}
        {children}
      </div>
    </GhostContext.Provider>
  );
}
