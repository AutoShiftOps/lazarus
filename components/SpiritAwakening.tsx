import type { CSSProperties } from "react";
import { awakeningState, RUNE_COUNT, type AwakeningStage } from "../lib/ui/awakening-state";

type Phase = "fetching" | "reading" | "stirring" | "awake";

const PHASES: Record<AwakeningStage, Phase> = {
  fetching: "fetching",
  "demo-sandbox": "fetching",
  reading: "reading",
  stirring: "stirring",
  raising: "awake",
};

/** Runes on the tombstone, as [x, y, path] in scene coordinates (glyph drawn around 0,0). */
const RUNES = [
  [226, 283, "M0 -6 V6 M-4 -2 L4 2"],
  [242, 283, "M-4 -6 L4 0 L-4 6"],
  [258, 283, "M0 -6 V6 M-4 3 L0 -1 L4 3"],
  [234, 301, "M-4 -6 L4 6 M4 -6 L-4 6"],
  [250, 301, "M-4 -6 V6 H4 M-4 0 H3"],
] as const;

/** Robe: hood, shoulders, long hem with a tattered edge. Symmetric about x = 160. */
const ROBE =
  "M160 34C176 34 190 50 190 70C190 88 196 98 208 108C222 122 226 150 230 184C232 200 238 212 246 226L232 222L226 240L212 224L204 244L190 228L180 248L166 230L156 250L144 230L132 246L124 226L110 242L104 224L92 238L88 222L74 226C82 212 88 200 90 184C94 150 98 122 112 108C124 98 130 88 130 70C130 50 144 34 160 34Z";

/** Region above the mound surface: the fixed mask the ghost rises behind. */
const MASK = "M0 0H320V300H250C230 270 200 262 160 262C120 262 90 270 70 300H0Z";

/**
 * "Spirit waking" progress scene. Decorative (aria-hidden); the stage text is the source of truth
 * and is rendered next to it. Each stage is a static state (data-phase, data-eyes, data-spirit,
 * --glow). The CSS in globals.css (.aw-*) moves between states with transform/opacity only.
 */
export function SpiritAwakening({ stage, label }: { stage: AwakeningStage; label?: string }) {
  const state = awakeningState(stage);
  const phase = PHASES[stage] ?? "fetching";
  return (
    <div
      className="awakening"
      data-stage={stage}
      data-phase={phase}
      data-eyes={state.eyes}
      data-spirit={state.spirit}
      style={{ ["--glow" as string]: state.glow } as CSSProperties}
    >
      <svg className="awakening-scene" viewBox="0 0 320 340" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="aw-moon-g">
            <stop offset="0%" stopColor="#dfe9ff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#dfe9ff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="aw-mist-g">
            <stop offset="0%" stopColor="#c6f3f0" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#c6f3f0" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="aw-ghost-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e9fbff" stopOpacity="0.75" />
            <stop offset="55%" stopColor="#bfe6f5" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#9fd8e8" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="aw-inner-g" cx="50%" cy="38%" r="55%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#7ff0e6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="aw-eye-g">
            <stop offset="0%" stopColor="#b9fff7" />
            <stop offset="60%" stopColor="#2fd6c8" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#2fd6c8" stopOpacity="0" />
          </radialGradient>
          {/* Static soft edge: fixed seed, applied once, never animated. */}
          <filter id="aw-soft" x="-10%" y="-5%" width="120%" height="115%">
            <feTurbulence type="fractalNoise" baseFrequency="0.022 0.035" numOctaves="2" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="5" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.8" />
          </filter>
          <path id="aw-robe" d={ROBE} />
          <clipPath id="aw-clip">
            <path d={MASK} />
          </clipPath>
        </defs>

        <circle className="aw-halo" cx="240" cy="64" r="86" fill="url(#aw-moon-g)" />
        <circle cx="240" cy="64" r="13" fill="#e9e4f5" opacity="0.55" />

        <g className="aw-mist-back" fill="url(#aw-mist-g)">
          <ellipse className="aw-mist aw-mist-a" cx="110" cy="282" rx="100" ry="14" />
          <ellipse className="aw-mist aw-mist-b" cx="224" cy="268" rx="90" ry="12" />
          <ellipse className="aw-mist aw-mist-c" cx="160" cy="296" rx="130" ry="12" />
        </g>

        <path className="aw-ground" d="M0 340V304C60 292 110 298 160 296C210 298 260 292 320 304V340Z" />
        <g className="aw-mound-g">
          <path className="aw-mound" d="M70 306C90 270 120 262 160 262C200 262 230 270 250 306Z" />
          <g className="aw-cracks" fill="none" strokeWidth="1.4" strokeLinecap="round">
            <path className="aw-crack" d="M140 298L146 284L139 276L150 266" />
            <path className="aw-crack" d="M176 300L170 288L178 280L172 268" />
            <path className="aw-crack" d="M112 300L118 290L112 284M206 300L200 290L208 284" />
          </g>
        </g>

        <g clipPath="url(#aw-clip)">
          <g className="aw-hand" fill="none" stroke="#dff6ff" strokeWidth="3" strokeLinecap="round">
            <path d="M144 276C144 262 146 254 148 249M150 276C150 260 152 250 154 244M156 276C157 262 159 254 161 248M162 276C163 266 165 260 168 256" />
          </g>
          <g className="aw-ghost">
            <g className="aw-float">
              <g className="aw-sway">
                <g filter="url(#aw-soft)">
                  <path
                    className="aw-tail"
                    d="M146 232C146 252 176 258 204 250C232 242 256 246 288 230C262 258 232 264 204 262C172 264 140 258 140 232Z"
                    fill="url(#aw-ghost-g)"
                  />
                  <use href="#aw-robe" fill="url(#aw-ghost-g)" />
                  <use className="aw-breathe" href="#aw-robe" fill="url(#aw-inner-g)" />
                  <use href="#aw-robe" fill="none" stroke="#8ff3ea" strokeOpacity="0.45" strokeWidth="1.2" />
                </g>
                <g className="aw-arm aw-arm-l" fill="none" stroke="#d8f4ff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round">
                  <path d="M112 114C104 136 100 156 100 176M100 176L97 185M100 176L101 186M100 176L105 184" />
                </g>
                <g className="aw-arm aw-arm-r" fill="none" stroke="#d8f4ff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round">
                  <path d="M208 114C216 136 220 156 220 176M220 176L223 185M220 176L219 186M220 176L215 184" />
                </g>
                <g className="aw-head">
                  <ellipse cx="160" cy="74" rx="20" ry="25" fill="#0c1a22" opacity="0.55" />
                  <ellipse cx="160" cy="76" rx="14" ry="19" fill="#cfeff0" opacity="0.22" />
                  <path d="M160 76V82" stroke="#0c1a22" strokeOpacity="0.4" strokeWidth="1.4" />
                  <ellipse cx="152" cy="70" rx="4.2" ry="5.6" fill="#04090d" opacity="0.92" />
                  <ellipse cx="168" cy="70" rx="4.2" ry="5.6" fill="#04090d" opacity="0.92" />
                  <g className="aw-eyes">
                    <circle cx="152" cy="71" r="6" fill="url(#aw-eye-g)" />
                    <circle cx="168" cy="71" r="6" fill="url(#aw-eye-g)" />
                  </g>
                  <ellipse cx="160" cy="90" rx="3.4" ry="5" fill="#04090d" opacity="0.85" />
                </g>
              </g>
            </g>
          </g>
        </g>

        <g className="aw-stone-g">
          <path className="aw-stone" d="M210 326V280C210 258 274 258 274 280V326Z" />
          <g className="aw-runes" fill="none" strokeWidth="1.8" strokeLinecap="round">
            {RUNES.slice(0, RUNE_COUNT).map(([x, y, d], i) => (
              <g key={i} transform={`translate(${x} ${y})`}>
                <path
                  className="aw-rune"
                  data-lit={i < state.runes ? "true" : "false"}
                  d={d}
                  style={{ ["--i" as string]: i } as CSSProperties}
                />
              </g>
            ))}
          </g>
        </g>

        <g className="aw-mist-front" fill="url(#aw-mist-g)">
          <ellipse className="aw-mist aw-wisp aw-wisp-a" cx="130" cy="306" rx="80" ry="9" />
          <ellipse className="aw-mist aw-wisp aw-wisp-b" cx="230" cy="322" rx="70" ry="8" />
        </g>
      </svg>
      {label ? <p className="mt-2 text-spectral">{label}</p> : null}
    </div>
  );
}
