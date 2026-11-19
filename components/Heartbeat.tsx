/** A small ECG line for a raised service. The "Raised" label carries the meaning; the line is decoration. */
export function Heartbeat() {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-spectral">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 120 24"
        width="120"
        height="24"
        className="heartbeat pointer-events-none h-6 w-[120px] shrink-0"
      >
        <path
          className="heartbeat-line"
          pathLength={100}
          d="M0 12 H30 L36 12 L40 4 L46 21 L51 1 L56 12 H66 L70 9 L75 12 H120"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Raised</span>
    </span>
  );
}
