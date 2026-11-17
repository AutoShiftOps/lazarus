/** Money helpers for Gravewood Bank. All money is integer cents; no floating point. */

const AMOUNT_RE = /^[0-9]{1,12}(\.[0-9]{1,2})?$/;
const MAX_CENTS = 10 ** 14;

/** Parse a decimal string (max 2 fractional digits) to positive integer cents, or null if invalid or zero. */
export function parseAmountToCents(s: string): number | null {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

/** Format signed integer cents with exactly 2 fractional digits, e.g. -120000 -> "-1200.00". Zero has no sign. */
export function formatSignedCents(c: number): string {
  if (!Number.isInteger(c)) {
    throw new RangeError(`Invalid cents value: ${String(c)}`);
  }
  return c < 0 ? `-${formatCents(-c)}` : formatCents(c);
}

/** Format integer cents with exactly 2 fractional digits, e.g. 1245000 -> "12450.00". */
export function formatCents(c: number): string {
  if (!Number.isInteger(c) || c < 0 || c > MAX_CENTS) {
    throw new RangeError(`Invalid cents value: ${String(c)}`);
  }
  const whole = Math.floor(c / 100);
  const frac = c % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}
