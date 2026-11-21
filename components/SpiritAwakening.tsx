import type { CSSProperties } from "react";
import Image from "next/image";
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

/** Region above the mound surface: the fixed mask the rising hand is clipped to. */
const MASK = "M0 0H320V300H250C230 270 200 262 160 262C120 262 90 270 70 300H0Z";

const VIEW_BOX = "-40 -50 400 420";

/**
 * "Spirit waking" progress scene. Decorative (aria-hidden); the stage text is the source of truth
 * and is rendered next to it. Each stage is a static state (data-phase, data-eyes, data-spirit,
 * --glow). The CSS in globals.css (.aw-*) moves between states with transform/opacity only.
 *
 * Layers, back to front: the scene svg (moon, back mist, mound, hand), the painted ghost
 * (public/ritual/ghost.png, always rendered so it is preloaded), then a second svg with the
 * tombstone and front mist so the ghost rises out of the mound.
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
      <div className="awakening-stage">
        <svg className="awakening-scene" viewBox={VIEW_BOX}
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
            {/* Soft vignette: transparent at the centre and again at the box edge, so no rectangle shows. */}
            <radialGradient id="aw-vig-g" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#02050a" stopOpacity="0" />
              <stop offset="45%" stopColor="#02050a" stopOpacity="0" />
              <stop offset="78%" stopColor="#02050a" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#02050a" stopOpacity="0" />
            </radialGradient>
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
          </g>

          <rect x="-40" y="-50" width="400" height="420" fill="url(#aw-vig-g)" />
        </svg>

        {/* The painted ghost: screen blend drops the black background, a fixed mask fades the smoke. */}
        <div className="aw-ghost-pos" aria-hidden="true">
          <div className="aw-ghost">
            <div className="aw-float">
              <div className="aw-dip">
                <div className="aw-breathe">
                  <Image
                    src="/ritual/ghost.png"
                    alt=""
                    aria-hidden="true"
                    width={832}
                    height={1248}
                    sizes="(max-width: 640px) 60vw, 480px"
                    quality={80}
                    preload
                    className="aw-ghost-img"
                  />
                  <span className="aw-eye-glow" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <svg className="awakening-front" viewBox={VIEW_BOX}
          style={{ overflow: "visible" }}
          aria-hidden="true"
          focusable="false"
        >
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
      </div>
      {label ? <p className="mt-2 text-spectral">{label}</p> : null}
    </div>
  );
}
