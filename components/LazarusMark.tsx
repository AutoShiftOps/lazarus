import Image from "next/image";

/**
 * The Lazarus mark as a lantern: the untouched logo asset sits on a layered glow
 * (teal bloom, amber halo, warm core) with a faint pair of hollow eyes in the flame.
 * Every glow layer is decorative and aria-hidden. Motion lives in globals.css.
 */
export function LazarusMark({
  size,
  alt = "",
  priority = false,
  className = "",
}: {
  /** Rendered size of the mark in px. */
  size: number;
  /** Empty when the mark sits next to the visible word "Lazarus". */
  alt?: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`lantern ${className}`}
      style={{ width: size, height: size }}
    >
      <span className="lantern-bloom" aria-hidden="true" />
      <span className="lantern-halo" aria-hidden="true" />
      <span className="lantern-core flame-flicker" aria-hidden="true" />
      <Image
        src="/lazarus-logo.svg"
        alt={alt}
        width={size}
        height={size}
        priority={priority}
        className="lantern-mark"
      />
      <svg
        className="lantern-eyes"
        viewBox="0 0 512 512"
        aria-hidden="true"
        focusable="false"
      >
        <g fill="#120f17" stroke="#c4fff6" strokeWidth="2">
          <ellipse cx="240" cy="168" rx="6" ry="9" />
          <ellipse cx="272" cy="168" rx="6" ry="9" />
        </g>
      </svg>
    </span>
  );
}
