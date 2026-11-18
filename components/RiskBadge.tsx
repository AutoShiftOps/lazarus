export type Risk = "read" | "write" | "destructive";

interface RiskBadgeProps {
  risk: Risk;
  reason?: string;
}

const LABELS: Record<Risk, string> = {
  read: "Calm",
  write: "Restless",
  destructive: "Vengeful",
};

const COLORS: Record<Risk, string> = {
  read: "text-spectral border-spectral/50",
  write: "text-candle border-candle/50",
  destructive: "text-vengeful border-vengeful/50",
};

function RiskIcon({ risk }: { risk: Risk }) {
  const common = {
    "aria-hidden": true,
    focusable: false,
    viewBox: "0 0 16 16",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0",
  };
  if (risk === "read") {
    // Open eye: observing only.
    return (
      <svg {...common} data-icon="eye">
        <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" />
        <circle cx="8" cy="8" r="1.8" />
      </svg>
    );
  }
  if (risk === "write") {
    // Flickering flame: something changes.
    return (
      <svg {...common} data-icon="flame">
        <path d="M8 1.5c.5 2.5 3.5 4 3.5 7.2A3.5 3.5 0 0 1 8 14.5a3.5 3.5 0 0 1-3.5-3.8c0-1.4.8-2.3 1.5-3 .3 1 .8 1.4 1.3 1.6C7.3 6 7.4 3.5 8 1.5z" />
      </svg>
    );
  }
  // Skull: destructive.
  return (
    <svg {...common} data-icon="skull">
      <path d="M3 7.5a5 5 0 0 1 10 0c0 1.6-.7 2.6-2 3.3V13H5v-2.2C3.7 10.1 3 9.1 3 7.5z" />
      <circle cx="6" cy="7.5" r="0.9" />
      <circle cx="10" cy="7.5" r="0.9" />
      <path d="M7 13v-1.5M9 13v-1.5" />
    </svg>
  );
}

export function RiskBadge({ risk, reason }: RiskBadgeProps) {
  const label = LABELS[risk];
  return (
    <span
      className={`group inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-full border bg-surface px-2.5 py-0.5 text-xs font-medium ${COLORS[risk]}`}
      title={reason}
      tabIndex={reason ? 0 : undefined}
      data-risk={risk}
    >
      <RiskIcon risk={risk} />
      <span>{label}</span>
      {reason ? (
        <span className="hidden basis-full break-words font-normal text-muted group-focus:block group-focus-within:block">
          {reason}
        </span>
      ) : null}
    </span>
  );
}
