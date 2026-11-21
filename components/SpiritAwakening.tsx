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

/** Body: narrow shoulders, a long thin torso, then uneven torn strips. Not symmetric. */
const ROBE =
  "M146 76C152 71 168 71 174 76C184 82 187 98 186 126C185 156 190 186 196 214L206 262L198 244L194 290L184 238L182 276L174 246L170 312L162 240L158 284L150 244L142 300L136 238L130 270L124 232L116 262L120 214C128 190 134 156 134 126C132 98 136 82 146 76Z";

/** Long thin tatters that trail below the body. */
const TATTERS =
  "M140 150L126 262L148 160ZM152 160L146 286L164 160ZM166 160L174 292L178 156ZM178 150L198 272L188 150ZM134 140L114 238L142 150ZM186 140L208 246L190 150Z";

/** Stretched hood, pulled to a point. */
const HOOD =
  "M160 6C150 8 142 26 141 46C140 60 143 72 148 82L172 82C178 72 181 60 180 46C179 26 170 8 160 6Z";

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
      <svg className="awakening-scene" viewBox="-40 -50 400 420"
        style={{ overflow: "visible" }}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="aw-moon-g">
            <stop offset="0%" stopColor="#dfe9ff" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#dfe9ff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="aw-mist-g">
            <stop offset="0%" stopColor="#b4cdd6" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#b4cdd6" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="aw-ghost-g" gradientUnits="userSpaceOnUse" x1="0" y1="70" x2="0" y2="250">
            <stop offset="0%" stopColor="#4b5d70" stopOpacity="0.5" />
            <stop offset="60%" stopColor="#7d96a6" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#a3c0cb" stopOpacity="0.45" />
          </linearGradient>
          <linearGradient id="aw-under-g" gradientUnits="userSpaceOnUse" x1="0" y1="262" x2="0" y2="120">
            <stop offset="0%" stopColor="#8fd0d8" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#8fd0d8" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="aw-hood-g" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="82">
            <stop offset="0%" stopColor="#141f2a" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#4a5f70" stopOpacity="0.6" />
          </linearGradient>
          <radialGradient id="aw-eye-g">
            <stop offset="0%" stopColor="#9fe9e2" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#2a9d98" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="aw-hollow-g" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#010305" stopOpacity="0.97" />
            <stop offset="65%" stopColor="#02060a" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#02060a" stopOpacity="0" />
          </radialGradient>
          {/* Soft vignette: transparent at the centre and again at the box edge, so no rectangle shows. */}
          <radialGradient id="aw-vig-g" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#02050a" stopOpacity="0" />
            <stop offset="45%" stopColor="#02050a" stopOpacity="0" />
            <stop offset="78%" stopColor="#02050a" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#02050a" stopOpacity="0" />
          </radialGradient>
          {/* Static soft edge: fixed seed, applied once, never animated. */}
          <filter id="aw-soft" x="-10%" y="-5%" width="120%" height="115%">
            <feTurbulence type="fractalNoise" baseFrequency="0.022 0.035" numOctaves="2" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="4" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.8" />
          </filter>
          {/* Fixed fade (not part of the rise): the lower robe dissolves into the mound. */}
          <linearGradient id="aw-fade-g" gradientUnits="userSpaceOnUse" x1="0" y1="212" x2="0" y2="272">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="100%" stopColor="#000" />
          </linearGradient>
          <mask id="aw-fade" maskUnits="userSpaceOnUse" x="-40" y="-50" width="400" height="420">
            <rect x="-40" y="-50" width="400" height="420" fill="url(#aw-fade-g)" />
          </mask>
          <radialGradient
            id="aw-ground-fade-g"
            gradientUnits="userSpaceOnUse"
            cx="160"
            cy="330"
            r="200"
            gradientTransform="translate(160 330) scale(1 0.5) translate(-160 -330)"
          >
            <stop offset="0%" stopColor="#fff" />
            <stop offset="60%" stopColor="#fff" />
            <stop offset="100%" stopColor="#000" />
          </radialGradient>
          <mask id="aw-ground-fade" maskUnits="userSpaceOnUse" x="-40" y="-50" width="400" height="420">
            <rect x="-40" y="-50" width="400" height="420" fill="url(#aw-ground-fade-g)" />
          </mask>
          <path id="aw-robe" d={ROBE} />
          <clipPath id="aw-clip">
            <path d={MASK} />
          </clipPath>
        </defs>

        <circle className="aw-halo" cx="240" cy="64" r="52" fill="url(#aw-moon-g)" />
        <circle cx="240" cy="64" r="13" fill="#e9e4f5" opacity="0.55" />

        <g className="aw-mist-back" fill="url(#aw-mist-g)">
          <ellipse className="aw-mist aw-mist-a" cx="110" cy="282" rx="100" ry="14" />
          <ellipse className="aw-mist aw-mist-b" cx="224" cy="268" rx="90" ry="12" />
          <ellipse className="aw-mist aw-mist-c" cx="160" cy="296" rx="130" ry="12" />
        </g>

        <path className="aw-ground" mask="url(#aw-ground-fade)" d="M-40 370V306C20 294 90 298 160 296C230 298 300 294 360 306V370Z" />
        <g className="aw-mound-g">
          <path className="aw-mound" d="M70 306C90 270 120 262 160 262C200 262 230 270 250 306Z" />
          <g className="aw-cracks" fill="none" strokeWidth="1.4" strokeLinecap="round">
            <path className="aw-crack" d="M140 298L146 284L139 276L150 266" />
            <path className="aw-crack" d="M176 300L170 288L178 280L172 268" />
            <path className="aw-crack" d="M112 300L118 290L112 284M206 300L200 290L208 284" />
          </g>
        </g>

        <g clipPath="url(#aw-clip)">
          <g className="aw-hand" fill="none" stroke="#c9dbe4" strokeWidth="3" strokeLinecap="round">
            <path d="M144 276C144 262 146 254 148 249M150 276C150 260 152 250 154 244M156 276C157 262 159 254 161 248M162 276C163 266 165 260 168 256" />
          </g>
          <g mask="url(#aw-fade)">
            <g className="aw-ghost">
              <g className="aw-float">
                <g className="aw-dip">
                  <g filter="url(#aw-soft)">
                    <path d={TATTERS} fill="url(#aw-ghost-g)" opacity="0.7" />
                    <use href="#aw-robe" fill="url(#aw-ghost-g)" />
                    <use className="aw-breathe" href="#aw-robe" fill="url(#aw-under-g)" />
                    <path d="M174 76C184 82 187 98 186 126C185 156 190 186 196 214L206 262" fill="none" stroke="#a9d3dc" strokeOpacity="0.5" strokeWidth="1.2" />
                  </g>
                  <g className="aw-arm aw-arm-l" fill="none" stroke="#9fb4c0" strokeOpacity="0.5" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M142 86C130 112 128 150 132 190M132 190L130 203M132 190L134 204M132 190L138 201M132 190L126 200M132 190L140 194" />
                  </g>
                  <g className="aw-arm aw-arm-r" fill="none" stroke="#b6cdd8" strokeOpacity="0.6" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M184 84C206 90 236 104 268 120C274 123 278 125 281 127" />
                    <path strokeWidth="1.4" d="M281 127C289 125 295 130 296 138M281 127C291 122 299 126 302 133M281 127C290 119 299 119 304 125M281 127C288 116 296 113 301 117M281 127C286 132 289 138 287 144" />
                  </g>
                  <g className="aw-head">
                    <g className="aw-sway">
                      <path d={HOOD} fill="url(#aw-hood-g)" filter="url(#aw-soft)" />
                      <path d="M170 10C177 26 180 44 178 62" fill="none" stroke="#a9d3dc" strokeOpacity="0.45" strokeWidth="1.1" />
                      <ellipse cx="160" cy="48" rx="12" ry="31" fill="url(#aw-hollow-g)" />
                      <g className="aw-eyes">
                        <ellipse cx="153" cy="54" rx="2.3" ry="7" fill="#010305" />
                        <ellipse cx="167" cy="50" rx="2" ry="6" fill="#010305" />
                        <ellipse cx="153" cy="54.5" rx="1.2" ry="4.6" fill="url(#aw-eye-g)" />
                        <ellipse cx="167" cy="50.5" rx="1.1" ry="4" fill="url(#aw-eye-g)" />
                      </g>
                      <path d="M160 66V77" fill="none" stroke="#010305" strokeWidth="1.5" strokeLinecap="round" />
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>

        <rect x="-40" y="-50" width="400" height="420" fill="url(#aw-vig-g)" />

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
          <ellipse className="aw-mist aw-wisp aw-wisp-a" cx="130" cy="272" rx="100" ry="13" />
          <ellipse className="aw-mist aw-wisp aw-wisp-b" cx="215" cy="288" rx="90" ry="10" />
          <ellipse className="aw-mist aw-wisp aw-wisp-a" cx="165" cy="262" rx="85" ry="10" />
        </g>
      </svg>
      {label ? <p className="mt-2 text-spectral">{label}</p> : null}
    </div>
  );
}
