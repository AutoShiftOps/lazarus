"use client";

import { useId } from "react";
import { useGhost } from "./GhostShell";

export function GhostSwitch() {
  const { ghost, token, busy, error, toggle } = useGhost();
  const ids = useId();
  const disabled = typeof token !== "string" || ghost === null;
  const on = ghost === true;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-4">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={`${ids}-label`}
          aria-describedby={`${ids}-desc`}
          aria-busy={busy}
          disabled={disabled}
          onClick={toggle}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-muted transition-colors duration-300 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candle disabled:cursor-not-allowed disabled:opacity-60 ${
            on ? "bg-spectral" : "bg-border"
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-text transition-transform duration-300 motion-reduce:transition-none ${
              on ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
        <div className="space-y-1">
          <p id={`${ids}-label`} className="text-base text-text">
            Ghost mode
          </p>
          <p id={`${ids}-desc`} className="text-sm text-muted">
            Dangerous calls are rehearsed, never sent.
          </p>
        </div>
      </div>
      {token === null ? <p className="text-sm text-muted">Only the owner can change this.</p> : null}
      {error !== "" ? (
        <p role="alert" className="text-sm text-vengeful">
          {error}
        </p>
      ) : null}
    </div>
  );
}
