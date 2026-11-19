/** Hero art: a graveyard silhouette with a candle-coloured glow rising from one grave. Decorative only. */
export function Graveyard({ className = "" }: { className?: string }) {
  return (
    <div className={`graveyard pointer-events-none ${className}`} aria-hidden="true">
      <svg viewBox="0 0 480 300" width="480" height="300" focusable="false" className="graveyard-art h-auto w-full">
        <defs>
          <radialGradient id="sky-glow">
            <stop offset="0%" style={{ stopColor: "#8b5cf6", stopOpacity: 1 }} />
            <stop offset="100%" style={{ stopColor: "#8b5cf6", stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="grave-glow">
            <stop offset="0%" style={{ stopColor: "var(--candle)", stopOpacity: 1 }} />
            <stop offset="100%" style={{ stopColor: "var(--candle)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <ellipse className="graveyard-sky" cx="240" cy="190" rx="230" ry="130" fill="url(#sky-glow)" />
        <circle className="grave-glow" cx="229" cy="190" r="34" fill="url(#grave-glow)" />
        <g className="graveyard-shape">
          {/* crooked bare tree */}
          <path d="M70 250 C72 220 66 200 74 170 C78 150 70 130 62 112 L50 90 L58 88 L70 106 L66 70 L74 70 L80 104 C86 96 98 84 104 62 L112 66 C106 90 94 106 88 122 C96 140 94 160 90 180 C88 210 92 230 96 250 Z" />
          <path d="M62 112 L36 104 L34 98 L66 104 Z M88 122 L120 112 L122 118 L92 130 Z" />
          {/* cross */}
          <path d="M168 250 L168 168 L158 168 L158 156 L168 156 L168 140 L182 140 L182 156 L192 156 L192 168 L182 168 L182 250 Z" />
          {/* tombstones */}
          <path d="M214 250 L214 208 C214 190 244 190 244 208 L244 250 Z" />
          <path d="M262 250 L262 196 C262 176 296 176 296 196 L296 250 Z" />
          <path d="M318 250 L318 220 L326 212 L350 212 L358 220 L358 250 Z" />
          <path d="M376 250 L378 200 L402 196 L406 250 Z" />
          <path d="M424 250 L424 224 C424 212 448 212 448 224 L448 250 Z" />
          {/* low rolling ground */}
          <path d="M0 300 L0 252 C60 236 110 262 180 250 C250 238 300 262 360 250 C410 240 450 246 480 252 L480 300 Z" />
        </g>
      </svg>
    </div>
  );
}
