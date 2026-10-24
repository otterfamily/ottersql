import {
  isNested,
  parseArrayLiteral,
  parseInterval,
  parseMultirangeLiteral,
  parseRangeLiteral,
} from "./literals.ts";
import type { ArrayItems, RangeText } from "./literals.ts";
import type { TypeInfo } from "./type-info.ts";

/** A value whose type cannot hold it exactly, such as `infinity` for a date (ADR 0008). */
export class DecodeError extends Error {
  override readonly name = "DecodeError";
}

/** Decodes one value of Postgres's text output into the JavaScript value ADR 0008 assigns its type. */
export function decodeValue(text: string | null, type: TypeInfo): unknown {
  if (text === null) {
    return null;
  }
  if (type.kind === "array") {
    return decodeArray(parseArrayLiteral(text), type.element);
  }
  if (type.kind === "range" || type.kind === "multirange") {
    return type.kind === "range"
      ? decodeRange(parseRangeLiteral(text), type.subtype)
      : parseMultirangeLiteral(text).map((range) => decodeRange(range, type.subtype));
  }
  return type.kind === "text" ? text : decodeBase(text, type.name);
}

function decodeArray(items: ArrayItems, element: TypeInfo): unknown[] {
  return items.map((item) =>
    isNested(item) ? decodeArray(item, element) : decodeValue(item, element),
  );
}

function decodeRange(range: RangeText, subtype: TypeInfo): unknown {
  return range === "empty"
    ? "empty"
    : {
        lower: decodeValue(range.lower, subtype),
        upper: decodeValue(range.upper, subtype),
        lowerInclusive: range.lowerInclusive,
        upperInclusive: range.upperInclusive,
      };
}

const baseDecoders: Readonly<Record<string, (text: string) => unknown>> = {
  bool: (text) => text === "t",
  bytea: (text) => bytesFromHex(text.slice(String.raw`\x`.length)),
  date: (text) => Temporal.PlainDate.from(isoYear(text)),
  float4: Number,
  float8: Number,
  int2: Number,
  int4: Number,
  interval: parseInterval,
  json: (text): unknown => JSON.parse(text),
  jsonb: (text): unknown => JSON.parse(text),
  oid: Number,
  // Temporal rejects Postgres's 24:00:00, which no PlainTime can hold.
  time: (text) => Temporal.PlainTime.from(text),
  timestamp: (text) => Temporal.PlainDateTime.from(isoYear(text)),
  timestamptz: (text) => Temporal.Instant.from(isoYear(text)),
};

function decodeBase(text: string, name: string): unknown {
  const decode = baseDecoders[name];
  if (decode === undefined) {
    return text;
  }
  try {
    return decode(text);
  } catch (error) {
    throw new DecodeError(
      `"${text}" cannot be decoded as ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const yearDigits = /^\d+/v;
const ISO_YEAR_DIGITS = 4;
const EXPANDED_YEAR_DIGITS = 6;

/**
 * Temporal reads Postgres's date and time output as it is, except for years: Postgres prints
 * `0044-03-15 BC` and `10000-01-01`, where ISO 8601 writes `-000043-03-15` and `+010000-01-01`
 * (1 BC is year 0). Other text, such as `infinity`, is left for Temporal to reject (ADR 0008).
 */
function isoYear(text: string): string {
  const digits = yearDigits.exec(text)?.[0];
  const bc = text.endsWith(" BC");
  if (digits === undefined || (digits.length === ISO_YEAR_DIGITS && !bc)) {
    return text;
  }
  const year = bc ? 1 - Number(digits) : Number(digits);
  const sign = year < 0 ? "-" : "+";
  const rest = text.slice(digits.length, bc ? -" BC".length : undefined);
  return `${sign}${String(Math.abs(year)).padStart(EXPANDED_YEAR_DIGITS, "0")}${rest}`;
}

const HEX_DIGITS_PER_BYTE = 2;
const HEX = 16;

function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      hex.slice(index * HEX_DIGITS_PER_BYTE, (index + 1) * HEX_DIGITS_PER_BYTE),
      HEX,
    );
  }
  return bytes;
}
