import { byteaBytes } from "./bytea.ts";
import { FormatError } from "./format-error.ts";
import {
  isNested,
  parseArrayLiteral,
  parseInterval,
  parseMultirangeLiteral,
  parseRangeLiteral,
} from "./literals.ts";
import type { ArrayItems, RangeText } from "./literals.ts";
import type { TypeInfo } from "./type-info.ts";
import { isoYear } from "./years.ts";

/** A value whose type cannot hold it exactly, such as `infinity` for a date (ADR 0008). */
export class DecodeError extends Error {
  override readonly name = "DecodeError";
}

type Decode = (text: string) => unknown;

/**
 * The decoder of one column's values, from Postgres's text output into the JavaScript value ADR
 * 0008 assigns its type. It throws a `DecodeError` naming the column and the type, but not the
 * value, when the value does not fit. Choosing it once per result leaves only the conversion to do per value.
 */
export function columnDecoder(column: string, type: TypeInfo): (text: string | null) => unknown {
  const decode = valueDecoder(type);
  return (text) => {
    if (text === null) {
      return null;
    }
    try {
      return decode(text);
    } catch (error) {
      // The value stays out of the error, since errors end up in logs and rows hold personal
      // data; so do the errors of parsers that quote it. ottersql's own reasons do not.
      const reason = error instanceof FormatError ? `: ${error.message}` : "";
      throw new DecodeError(
        `Column "${column}" has a value that cannot be decoded as ${typeName(type)}${reason}`,
      );
    }
  };
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

const asText: Decode = (text) => text;

function valueDecoder(type: TypeInfo): Decode {
  if (type.kind === "array") {
    const element = valueDecoder(type.element);
    return (text) => decodeArray(parseArrayLiteral(text, type.delimiter), element);
  }
  if (type.kind === "range" || type.kind === "multirange") {
    const bound = valueDecoder(type.subtype);
    return type.kind === "range"
      ? (text) => decodeRange(parseRangeLiteral(text), bound)
      : (text) => parseMultirangeLiteral(text).map((range) => decodeRange(range, bound));
  }
  return type.kind === "text" ? asText : (baseCodecs[type.name]?.decode ?? asText);
}

function decodeArray(items: ArrayItems, element: Decode): unknown[] {
  return items.map((item) => {
    if (item === null) {
      return null;
    }
    return isNested(item) ? decodeArray(item, element) : element(item);
  });
}

function decodeRange(range: RangeText, bound: Decode): unknown {
  return range === "empty"
    ? "empty"
    : {
        lower: range.lower === null ? null : bound(range.lower),
        upper: range.upper === null ? null : bound(range.upper),
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
  // Numbers a JavaScript number cannot hold exactly are rounded, as JSON.parse does (ADR 0014).
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
