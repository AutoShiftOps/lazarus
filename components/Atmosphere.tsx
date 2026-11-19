/**
 * Decorative night sky: moon, faint stars, drifting mist and a few bats.
 * Fixed behind the content (z-index 0), never interactive, clipped so it cannot scroll the page.
 * All motion is defined in globals.css and switched off by Still mode / reduced motion.
 */

const BATS = [
  { top: "12%", duration: 22, delay: 0, path: "ltr", scale: 1 },
  { top: "30%", duration: 17, delay: 5, path: "rtl", scale: 0.8 },
  { top: "20%", duration: 26, delay: 11, path: "ltr-b", scale: 1.2 },
  { top: "46%", duration: 14, delay: 3, path: "rtl", scale: 0.7 },
  { top: "8%", duration: 28, delay: 15, path: "rtl", scale: 0.9 },
  { top: "38%", duration: 20, delay: 8, path: "ltr-b", scale: 0.85 },
] as const;

function Bat({ top, duration, delay, path, scale, index }: (typeof BATS)[number] & { index: number }) {
  return (
    <span
      className={`bat bat-${index + 1} bat-path-${path}`}
      style={{
        top,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
        ["--bat-scale" as string]: scale,
      }}
    >
      <svg viewBox="0 0 40 20" width="40" height="20" focusable="false">
        <g className="bat-wing bat-wing-left">
          <path d="M20 10 C16 2 8 1 1 4 C5 6 5 9 8 11 C10 9 13 10 14 13 C16 11 18 11 20 14 Z" />
        </g>
        <g className="bat-wing bat-wing-right">
          <path d="M20 10 C24 2 32 1 39 4 C35 6 35 9 32 11 C30 9 27 10 26 13 C24 11 22 11 20 14 Z" />
        </g>
        <path d="M18 8 L17 4 L20 7 L23 4 L22 8 C23 10 22 15 20 17 C18 15 17 10 18 8 Z" />
      </svg>
    </span>
  );
}

export function Atmosphere() {
  return (
    <div className="atmosphere" aria-hidden="true">
      <div className="spirit-mist" />
      <svg className="moon" viewBox="0 0 200 200" focusable="false">
        <defs>
          <radialGradient id="moon-glow">
            <stop offset="30%" style={{ stopColor: "var(--moon)", stopOpacity: 1 }} />
            <stop offset="100%" style={{ stopColor: "var(--moon)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <circle cx="100" cy="100" r="100" fill="url(#moon-glow)" />
        <circle className="moon-disc" cx="100" cy="100" r="34" />
        <circle className="moon-shade" cx="88" cy="92" r="6" />
        <circle className="moon-shade" cx="112" cy="108" r="4" />
      </svg>
      <svg className="stars" viewBox="0 0 400 200" preserveAspectRatio="none" focusable="false">
        <circle cx="60" cy="40" r="1.6" />
        <circle cx="210" cy="90" r="1.2" />
        <circle cx="320" cy="150" r="1.4" />
      </svg>
      {BATS.map((bat, i) => (
        <Bat key={i} index={i} {...bat} />
      ))}
    </div>
  );
}
