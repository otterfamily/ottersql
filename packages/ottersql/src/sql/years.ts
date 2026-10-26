import { FormatError } from "./format-error.ts";

// Postgres prints `0044-03-15 BC` and `10000-01-01` where ISO 8601, and Temporal, write
// `-000043-03-15` and `+010000-01-01`: there is no year 0 in Postgres, and 1 BC is ISO's year 0.
const yearDigits = /^\d+/v;
const isoDate = /^\d{4,}-/v;
const signedYear = /^(?<sign>[+\-])(?<digits>\d{6})/v;
const ISO_YEAR_DIGITS = 4;
const EXPANDED_YEAR_DIGITS = 6;
const BC = " BC";

/**
 * Postgres's date and time output with its year as ISO 8601 writes it, which Temporal reads.
 * Other text, such as `infinity`, is left for Temporal to reject (ADR 0008).
 */
export function isoYear(text: string): string {
  requireIsoDateStyle(text);
  const bc = text.endsWith(BC);
  return text.charAt(ISO_YEAR_DIGITS) === "-" && !bc ? text : expandedYear(text, bc);
}

/** `text` with its year in ISO 8601's expanded, signed form. */
function expandedYear(text: string, bc: boolean): string {
  const digits = yearDigits.exec(text)?.[0];
  if (digits === undefined) {
    return text;
  }
  const year = bc ? 1 - Number(digits) : Number(digits);
  const sign = year < 0 ? "-" : "+";
  const rest = text.slice(digits.length, bc ? -BC.length : undefined);
  return `${sign}${String(Math.abs(year)).padStart(EXPANDED_YEAR_DIGITS, "0")}${rest}`;
}

/** Dates in other DateStyles put the day or the month first, which no year rule can read. */
function requireIsoDateStyle(text: string): void {
  if (!isoDate.test(text) && !text.endsWith("infinity")) {
    throw new FormatError("not in the ISO DateStyle; set DateStyle to ISO");
  }
}

/** A Temporal value's ISO 8601 text with its year as Postgres reads it: `isoYear` reversed. */
export function postgresYear(text: string): string {
  const signed = signedYear.exec(text)?.groups;
  const year =
    signed === undefined
      ? Number(text.slice(0, ISO_YEAR_DIGITS))
      : Number(`${signed["sign"] ?? ""}${signed["digits"] ?? ""}`);
  const digits = signed === undefined ? ISO_YEAR_DIGITS : 1 + EXPANDED_YEAR_DIGITS;
  if (signed === undefined && year !== 0) {
    return text;
  }
  const rest = text.slice(digits);
  return year > 0
    ? `${String(year).padStart(ISO_YEAR_DIGITS, "0")}${rest}`
    : `${String(1 - year).padStart(ISO_YEAR_DIGITS, "0")}${rest}${BC}`;
}
