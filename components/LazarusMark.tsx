import { useId } from "react";

/**
 * The Lazarus mark as a lantern. One inline SVG in logo coordinates (512x512 plus 128 units of
 * padding on every side for the glow), so every layer stays aligned with the untouched logo asset
 * at any size. All layers are decorative; the SVG is aria-hidden. Motion lives in globals.css.
 *
 * variant "plain" (header): image plus the faint bloom and halo, no flicker, no burning eyes.
 * variant "lantern" (hero): the full set of layers.
 */

const BRACE_LEFT =
  "M238 222 c -11 0 -11 5 -11 13 c 0 9 -4 11 -10 11 c 6 0 10 2 10 11 c 0 8 0 13 11 13";
const BRACE_RIGHT =
  "M278 222 c 11 0 11 5 11 13 c 0 9 4 11 10 11 c -6 0 -10 2 -10 11 c 0 8 0 13 -11 13";
const POCKET_EDGE = "M112 306 L256 390 L400 306";
const FLAP_EDGE = "M110 292 L256 206 L402 292";
const POCKET_SHAPE = "M104 304 L256 392 L408 304 L408 444 Q408 464 388 464 L124 464 Q104 464 104 444 Z";

export function LazarusMark({
  size,
  alt = "",
  variant = "lantern",
  className = "",
}: {
  /** Rendered size of the logo itself in px (the glow extends beyond it). */
  size: number;
  /** Accessible name; leave empty when the mark sits next to the visible word "Lazarus". */
  alt?: string;
  variant?: "plain" | "lantern";
  className?: string;
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}-${name}`;
  const ref = (name: string): string => `url(#${id(name)})`;
  const full = variant === "lantern";

  return (
    <span
      className={`lantern ${className}`}
      data-variant={variant}
      style={{ width: size, height: size }}
    >
      {alt ? <span className="sr-only">{alt}</span> : null}
      <svg
        className="lantern-svg"
        viewBox="-128 -128 768 768"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id={id("bloom")}>
            <stop offset="0" stopColor="#4fd1c5" stopOpacity="1" />
            <stop offset="1" stopColor="#4fd1c5" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={id("halo")}>
            <stop offset="0" stopColor="#e8fffb" stopOpacity="0.55" />
            <stop offset="1" stopColor="#4fd1c5" stopOpacity="0" />
          </radialGradient>
          <filter id={id("blur-halo")} filterUnits="userSpaceOnUse" x="-128" y="-128" width="768" height="768">
            <feGaussianBlur stdDeviation="12" />
          </filter>
          {full ? (
            <>
              <radialGradient id={id("spill")}>
                <stop offset="0" stopColor="#4fd1c5" stopOpacity="0.8" />
                <stop offset="0.55" stopColor="#f2a541" stopOpacity="0.5" />
                <stop offset="1" stopColor="#f2a541" stopOpacity="0" />
              </radialGradient>
              <clipPath id={id("pocket")}>
                <path d={POCKET_SHAPE} />
              </clipPath>
              <filter id={id("blur-core")} filterUnits="userSpaceOnUse" x="-128" y="-128" width="768" height="768">
                <feGaussianBlur stdDeviation="14" />
              </filter>
              <filter id={id("blur-rim")} filterUnits="userSpaceOnUse" x="-128" y="-128" width="768" height="768">
                <feGaussianBlur stdDeviation="6" />
              </filter>
              <filter id={id("blur-eye")} filterUnits="userSpaceOnUse" x="-128" y="-128" width="768" height="768">
                <feGaussianBlur stdDeviation="5" />
              </filter>
            </>
          ) : null}
        </defs>

        {/* a. outer bloom (under the logo) */}
        <ellipse
          className="lm-bloom"
          cx="256"
          cy="235"
          rx="230"
          ry="250"
          fill={ref("bloom")}
        />
        {/* b. mid halo (under the logo) */}
        <ellipse
          className="lm-halo"
          cx="256"
          cy="240"
          rx="130"
          ry="160"
          fill={ref("halo")}
          filter={ref("blur-halo")}
        />

        <image href="/lazarus-logo.svg" x="0" y="0" width="512" height="512" />

        {full ? (
          <>
            {/* e. spill inside the pocket, clipped to the front pocket */}
            <g clipPath={ref("pocket")} className="lm-spill">
              <ellipse cx="256" cy="350" rx="120" ry="60" fill={ref("spill")} />
            </g>
            {/* d. rim light on the amber edges of the envelope */}
            <g
              className="lm-rim"
              fill="none"
              stroke="#ffd9a0"
              strokeWidth="14"
              strokeLinejoin="round"
              strokeLinecap="round"
              filter={ref("blur-rim")}
            >
              <path d={POCKET_EDGE} />
              <path d={FLAP_EDGE} />
            </g>
            {/* c. hot core over the flame */}
            <ellipse
              className="lm-core"
              cx="256"
              cy="230"
              rx="45"
              ry="70"
              fill="#ffffff"
              filter={ref("blur-core")}
            />
            {/* f. burning eyes: the logo's own brace paths, redrawn bright, plus a blurred glow */}
            <g
              className="lm-eye-glow"
              fill="none"
              stroke="#c4fff6"
              strokeWidth="14"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={ref("blur-eye")}
            >
              <path d={BRACE_LEFT} />
              <path d={BRACE_RIGHT} />
            </g>
            <g
              className="lm-eyes"
              fill="none"
              stroke="#ffffff"
              strokeWidth="7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={BRACE_LEFT} />
              <path d={BRACE_RIGHT} />
            </g>
          </>
        ) : null}
      </svg>
    </span>
  );
}
