import type { CSSProperties } from "react";
import { awakeningState, RUNE_COUNT, type AwakeningStage } from "../lib/ui/awakening-state";

const RUNES = [
  { x: 78, y: 120, d: "M0 -8 L0 8 M-5 -3 L5 3" },
  { x: 106, y: 92, d: "M-5 -8 L5 0 L-5 8" },
  { x: 160, y: 76, d: "M0 -8 L0 8 M-6 4 L0 -2 L6 4" },
  { x: 214, y: 92, d: "M-5 -8 L5 8 M5 -8 L-5 8" },
  { x: 242, y: 120, d: "M-5 -8 L-5 8 L5 8 M-5 0 L3 0" },
] as const;

const MOTES = [
  { x: 120, y: 168, delay: 0 },
  { x: 168, y: 176, delay: 1.4 },
  { x: 204, y: 162, delay: 2.8 },
  { x: 142, y: 150, delay: 4.2 },
] as const;

/**
 * "Spirit waking" progress scene. The scene is decorative (aria-hidden); the stage text is the
 * source of truth and is rendered under it. Each stage has its own static state, set through
 * data attributes; CSS transitions move between them (see .awakening in globals.css).
 */
export function SpiritAwakening({ stage, label }: { stage: AwakeningStage; label?: string }) {
  const state = awakeningState(stage);
  return (
    <div
      className="awakening"
      data-stage={stage}
      data-eyes={state.eyes}
      data-spirit={state.spirit}
      style={{ ["--glow" as string]: state.glow } as CSSProperties}
    >
      <svg
        className="awakening-scene"
        viewBox="0 0 320 220"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="aw-halo-grad">
            <stop offset="0%" style={{ stopColor: "var(--candle)", stopOpacity: 0.9 }} />
            <stop offset="100%" style={{ stopColor: "var(--candle)", stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id="aw-spirit-grad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" style={{ stopColor: "var(--spectral)", stopOpacity: 0.15 }} />
            <stop offset="100%" style={{ stopColor: "#c4fff6", stopOpacity: 0.85 }} />
          </linearGradient>
        </defs>

        <circle className="aw-halo" cx="160" cy="120" r="90" fill="url(#aw-halo-grad)" />
        <ellipse className="aw-soil-glow" cx="160" cy="186" rx="70" ry="10" fill="var(--candle)" />

        <g className="aw-spirit">
          <path
            d="M160 176 C124 160 116 118 136 92 C148 76 144 54 154 34 C158 48 168 58 180 66 C202 82 208 116 194 142 C186 160 176 168 160 176 Z"
            fill="url(#aw-spirit-grad)"
          />
          <g className="aw-eyes-closed" stroke="#120f17" strokeWidth="2.5" strokeLinecap="round" fill="none">
            <path d="M146 98 H156" />
            <path d="M166 98 H176" />
          </g>
          <g className="aw-eyes-open">
            <ellipse cx="151" cy="98" rx="4.5" ry="6" />
            <ellipse cx="171" cy="98" rx="4.5" ry="6" />
          </g>
        </g>

        <g className="aw-mist">
          <ellipse cx="120" cy="176" rx="46" ry="7" />
          <ellipse cx="204" cy="172" rx="40" ry="6" />
        </g>

        <g className="aw-runes" fill="none" strokeWidth="2" strokeLinecap="round">
          {RUNES.slice(0, RUNE_COUNT).map((r, i) => (
            <path
              key={i}
              className="aw-rune"
              data-lit={i < state.runes ? "true" : "false"}
              d={r.d}
              transform={`translate(${r.x} ${r.y})`}
              style={{ ["--i" as string]: i } as CSSProperties}
            />
          ))}
        </g>

        <g className="aw-motes">
          {MOTES.map((m, i) => (
            <circle
              key={i}
              className="aw-mote"
              cx={m.x}
              cy={m.y}
              r="1.8"
              style={{ animationDelay: `${m.delay}s` }}
            />
          ))}
        </g>

        <path className="aw-ground" d="M0 220 L0 190 C60 176 110 182 160 180 C210 182 260 176 320 190 L320 220 Z" />
        <path
          className="aw-mound"
          d="M96 200 C100 172 128 160 160 160 C192 160 220 172 224 200 Z"
        />
        <path className="aw-stone" d="M142 190 L142 160 C142 146 178 146 178 160 L178 190 Z" />
        <path className="aw-crack" d="M130 200 L138 188 L132 180 L144 170" fill="none" strokeWidth="1.5" />
        <path className="aw-crack" d="M192 200 L184 186 L192 178" fill="none" strokeWidth="1.5" />
      </svg>
      {label ? <p className="mt-2 text-spectral">{label}</p> : null}
    </div>
  );
}
