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
  date: (text) => Temporal.PlainDate.from(dateFields(text, "date")),
  float4: Number,
  float8: Number,
  int2: Number,
  int4: Number,
  interval: parseInterval,
  json: (text): unknown => JSON.parse(text),
  jsonb: (text): unknown => JSON.parse(text),
  oid: Number,
  time: (text) => Temporal.PlainTime.from(clockFields(text, "time")),
  timestamp: decodeTimestamp,
  timestamptz: decodeTimestamptz,
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

const dateText = /^(?<year>\d{4,})-(?<month>\d{2})-(?<day>\d{2})(?<bc> BC)?$/v;
const dateTimeText =
  /^(?<year>\d{4,})-(?<month>\d{2})-(?<day>\d{2}) (?<clock>\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(?<offset>[+\-]\d{2}(?::\d{2}){0,2})?(?<bc> BC)?$/v;
const clockText = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,6}))?$/v;
const FRACTION_DIGITS = 6;
const MICROSECONDS_PER_MILLISECOND = 1000;

interface DateFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface ClockFields {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly microsecond: number;
}

/** ISO years count 1 BC as 0, Postgres prints it as `0001 BC`. */
function isoDate(groups: Readonly<Record<string, string | undefined>>): DateFields {
  const year = Number(groups["year"]);
  return {
    year: groups["bc"] === undefined ? year : 1 - year,
    month: Number(groups["month"]),
    day: Number(groups["day"]),
  };
}

function dateFields(text: string, type: string): DateFields {
  const groups = dateText.exec(text)?.groups;
  if (groups === undefined) {
    throw new TypeError(`not a finite ${type}`);
  }
  return isoDate(groups);
}

/** Rejects times Temporal cannot hold, such as Postgres's `24:00:00`. */
function clockFields(text: string, type: string): ClockFields {
  const groups = clockText.exec(text)?.groups;
  if (groups === undefined) {
    throw new TypeError(`not a ${type}`);
  }
  const microseconds = Number((groups["fraction"] ?? "").padEnd(FRACTION_DIGITS, "0"));
  const time = {
    hour: Number(groups["hour"]),
    minute: Number(groups["minute"]),
    second: Number(groups["second"]),
    millisecond: Math.trunc(microseconds / MICROSECONDS_PER_MILLISECOND),
    microsecond: microseconds % MICROSECONDS_PER_MILLISECOND,
  };
  Temporal.PlainTime.from(time, { overflow: "reject" });
  return time;
}

function dateTime(
  text: string,
  type: string,
): { readonly fields: DateFields & ClockFields; readonly offset: string | undefined } {
  const groups = dateTimeText.exec(text)?.groups;
  if (groups === undefined) {
    throw new TypeError(`not a finite ${type}`);
  }
  return {
    fields: { ...isoDate(groups), ...clockFields(groups["clock"] ?? "", type) },
    offset: groups["offset"],
  };
}

function decodeTimestamp(text: string): Temporal.PlainDateTime {
  return Temporal.PlainDateTime.from(dateTime(text, "timestamp").fields);
}

const offsetText = /^(?<sign>[+\-])(?<hours>\d{2})(?::(?<minutes>\d{2}))?(?::(?<seconds>\d{2}))?$/v;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/** Offsets may have seconds (historic local mean time), which Temporal time zone ids cannot. */
function decodeTimestamptz(text: string): Temporal.Instant {
  const { fields, offset } = dateTime(text, "timestamptz");
  const groups = offsetText.exec(offset ?? "+00")?.groups;
  const seconds =
    Number(groups?.["hours"]) * SECONDS_PER_HOUR +
    Number(groups?.["minutes"] ?? 0) * SECONDS_PER_MINUTE +
    Number(groups?.["seconds"] ?? 0);
  const utc = Temporal.PlainDateTime.from(fields).toZonedDateTime("UTC").toInstant();
  return utc.subtract({ seconds: groups?.["sign"] === "-" ? -seconds : seconds });
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
