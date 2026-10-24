import { byteaBytes } from "./bytea.ts";
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

/**
 * Decodes one column's value of Postgres's text output into the JavaScript value ADR 0008 assigns
 * its type. Throws a `DecodeError` naming the column and the value when the value does not fit.
 */
export function decodeColumn(column: string, text: string | null, type: TypeInfo): unknown {
  try {
    return decodeValue(text, type);
  } catch (error) {
    throw new DecodeError(
      `Column "${column}": "${String(text)}" cannot be decoded as ${typeName(type)}`,
      { cause: error },
    );
  }
}

function typeName(type: TypeInfo): string {
  if (type.kind === "array") {
    return `${typeName(type.element)}[]`;
  }
  if (type.kind === "range" || type.kind === "multirange") {
    return `${type.kind} of ${typeName(type.subtype)}`;
  }
  return type.kind === "text" ? "text" : type.name;
}

function decodeValue(text: string | null, type: TypeInfo): unknown {
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

/**
 * What ottersql does with values of a built-in base type (ADR 0008). The content mapper types
 * queries from the same table, so a type and its codec cannot drift apart. Types without a codec
 * arrive as Postgres's text and are typed `string`.
 */
export interface BaseCodec {
  /** The TypeScript type of decoded values. */
  readonly type: string;
  /** The TypeScript type parameters accept, where `encodeParameter` takes more or other values. */
  readonly parameterType?: string;
  readonly decode?: (text: string) => unknown;
}

export const baseCodecs: Readonly<Record<string, BaseCodec>> = {
  bool: { type: "boolean", decode: (text) => text === "t" },
  bytea: { type: "Uint8Array", decode: byteaBytes },
  date: { type: "Temporal.PlainDate", decode: (text) => Temporal.PlainDate.from(isoYear(text)) },
  float4: { type: "number", decode: Number },
  float8: { type: "number", decode: Number },
  int2: { type: "number", decode: Number },
  int4: { type: "number", decode: Number },
  // Postgres accepts any int8, so a number or bigint is as good as the exact string it returns.
  int8: { type: "string", parameterType: "string | number | bigint" },
  interval: { type: "Interval", decode: parseInterval },
  json: { type: "unknown", parameterType: "Json", decode: (text): unknown => JSON.parse(text) },
  jsonb: { type: "unknown", parameterType: "Json", decode: (text): unknown => JSON.parse(text) },
  oid: { type: "number", decode: Number },
  // Temporal rejects Postgres's 24:00:00, which no PlainTime can hold.
  time: { type: "Temporal.PlainTime", decode: (text) => Temporal.PlainTime.from(text) },
  timestamp: {
    type: "Temporal.PlainDateTime",
    decode: (text) => Temporal.PlainDateTime.from(isoYear(text)),
  },
  timestamptz: {
    type: "Temporal.Instant",
    decode: (text) => Temporal.Instant.from(isoYear(text)),
  },
};

function decodeBase(text: string, name: string): unknown {
  const decode = baseCodecs[name]?.decode;
  return decode === undefined ? text : decode(text);
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
