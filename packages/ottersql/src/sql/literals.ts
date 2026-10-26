import { FormatError } from "./format-error.ts";
import type { Interval } from "./values.ts";

/** An array literal's elements as text, nested for multidimensional arrays; `null` for NULL. */
export type ArrayItems = readonly (string | null | ArrayItems)[];

/** The bounds of a range literal as text; `null` for an unbounded side. */
export type RangeText =
  | "empty"
  | {
      readonly lower: string | null;
      readonly upper: string | null;
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    };

/**
 * Reads Postgres's array output (`array_out`), such as `{1,NULL,"a,b"}` or `[0:1]={1,2}`, whose
 * elements are separated by their type's delimiter: a comma for every type but `box`'s semicolon.
 */
export function parseArrayLiteral(text: string, delimiter: string): ArrayItems {
  const start = text.startsWith("[") ? text.indexOf("=") + 1 : 0;
  return new LiteralReader(text, start, delimiter).array();
}

/** Reads Postgres's range output (`range_out`), such as `[1,5)`, `(,"a b"]` or `empty`. */
export function parseRangeLiteral(text: string): RangeText {
  return text === "empty" ? "empty" : new LiteralReader(text, 0, ",").range();
}

/** Reads Postgres's multirange output, such as `{[1,3),[5,7)}`. */
export function parseMultirangeLiteral(text: string): RangeText[] {
  return new LiteralReader(text, 0, ",").ranges();
}

/** Writes an array literal Postgres reads back as the same elements. */
export function arrayLiteral(items: ArrayItems): string {
  return `{${items.map((item) => (isNested(item) ? arrayLiteral(item) : quoteElement(item))).join(",")}}`;
}

/** Whether an array literal item is a nested array rather than an element. */
export function isNested(item: string | null | ArrayItems): item is ArrayItems {
  return Array.isArray(item);
}

/** Writes a range literal; bounds are already encoded as text. */
export function rangeLiteral(range: RangeText): string {
  if (range === "empty") {
    return "empty";
  }
  const lower = range.lower === null ? "" : quoteBound(range.lower);
  const upper = range.upper === null ? "" : quoteBound(range.upper);
  return `${range.lowerInclusive ? "[" : "("}${lower},${upper}${range.upperInclusive ? "]" : ")"}`;
}

function quoteElement(item: string | null): string {
  if (item === null) {
    return "NULL";
  }
  return item === "" || /^null$/iv.test(item) || /[\s",\\\{\}]/v.test(item) ? quote(item) : item;
}

function quoteBound(bound: string): string {
  return bound === "" || /[\s"\(\),\[\\\]]/v.test(bound) ? quote(bound) : bound;
}

function quote(text: string): string {
  return `"${text.replaceAll(/["\\]/gv, String.raw`\$&`)}"`;
}

const MONTHS_PER_YEAR = 12;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const FRACTION_DIGITS = 6;
const TOKENS_PER_PART = 2;
const monthsPerUnit = { year: MONTHS_PER_YEAR, mon: 1, day: 0 } as const;
const clockToken =
  /^(?<sign>[+\-]?)(?<hours>\d+):(?<minutes>\d{2}):(?<seconds>\d{2})(?:\.(?<fraction>\d{1,6}))?$/v;
const isoInterval =
  /^P(?:(?<years>-?\d+)Y)?(?:(?<months>-?\d+)M)?(?:(?<days>-?\d+)D)?(?:T(?:(?<hours>-?\d+)H)?(?:(?<minutes>-?\d+)M)?(?:(?<seconds>-?\d+)(?:\.(?<fraction>\d{1,6}))?S)?)?$/v;

interface Clock {
  readonly negative: boolean;
  readonly hours: string | undefined;
  readonly minutes: string | undefined;
  readonly seconds: string | undefined;
  readonly fraction: string | undefined;
}

/**
 * Reads an interval in the `postgres` (default) or `iso_8601` IntervalStyle. Other styles throw,
 * since reading them correctly would need the session's style.
 */
export function parseInterval(text: string): Interval {
  const iso = isoInterval.exec(text)?.groups;
  return iso === undefined ? parsePostgresInterval(text) : parseIsoInterval(iso);
}

function parseIsoInterval(groups: Readonly<Record<string, string | undefined>>): Interval {
  return {
    months: Number(groups["years"] ?? 0) * MONTHS_PER_YEAR + Number(groups["months"] ?? 0),
    days: Number(groups["days"] ?? 0),
    // Each of hours, minutes and seconds carries its own sign, and seconds' covers the fraction.
    microseconds:
      BigInt(groups["hours"] ?? 0) * SECONDS_PER_HOUR * MICROSECONDS_PER_SECOND +
      BigInt(groups["minutes"] ?? 0) * SECONDS_PER_MINUTE * MICROSECONDS_PER_SECOND +
      clockMicroseconds({
        negative: groups["seconds"]?.startsWith("-") === true,
        hours: undefined,
        minutes: undefined,
        seconds: groups["seconds"]?.replace("-", ""),
        fraction: groups["fraction"],
      }),
  };
}

/** `postgres` style: amount and unit pairs such as `1 year 2 mons -3 days`, then a clock such as `-04:05:06.789`. */
function parsePostgresInterval(text: string): Interval {
  const tokens = text.split(" ");
  const clock = clockToken.exec(tokens.at(-1) ?? "")?.groups;
  return {
    ...calendarParts(clock === undefined ? tokens : tokens.slice(0, -1)),
    microseconds:
      clock === undefined
        ? 0n
        : clockMicroseconds({
            negative: clock["sign"] === "-",
            hours: clock["hours"],
            minutes: clock["minutes"],
            seconds: clock["seconds"],
            fraction: clock["fraction"],
          }),
  };
}

function calendarParts(tokens: readonly string[]): Pick<Interval, "months" | "days"> {
  let months = 0;
  let days = 0;
  for (let index = 0; index < tokens.length; index += TOKENS_PER_PART) {
    const amount = Number(tokens[index]);
    const unit = intervalUnit(tokens[index + 1]);
    months += amount * monthsPerUnit[unit];
    days += unit === "day" ? amount : 0;
  }
  return { months, days };
}

function intervalUnit(token: string | undefined): keyof typeof monthsPerUnit {
  const unit = token?.replace(/s$/v, "");
  if (unit !== "year" && unit !== "mon" && unit !== "day") {
    throw new FormatError("unsupported interval format; set IntervalStyle to postgres or iso_8601");
  }
  return unit;
}

function clockMicroseconds(clock: Clock): bigint {
  const wholeSeconds =
    BigInt(clock.hours ?? 0) * SECONDS_PER_HOUR +
    BigInt(clock.minutes ?? 0) * SECONDS_PER_MINUTE +
    BigInt(clock.seconds ?? 0);
  const magnitude =
    wholeSeconds * MICROSECONDS_PER_SECOND +
    BigInt((clock.fraction ?? "").padEnd(FRACTION_DIGITS, "0"));
  return clock.negative ? -magnitude : magnitude;
}

/** Writes an interval in a form Postgres reads whatever its IntervalStyle. */
export function intervalLiteral(interval: Interval): string {
  return `${String(interval.months)} mons ${String(interval.days)} days ${String(interval.microseconds)} microseconds`;
}

/** Reads array, range and multirange literals one character at a time, without backtracking. */
class LiteralReader {
  readonly #text: string;
  /** What separates array elements; ranges always use a comma. */
  readonly #delimiter: string;
  #position: number;

  constructor(text: string, position: number, delimiter: string) {
    this.#text = text;
    this.#position = position;
    this.#delimiter = delimiter;
  }

  array(): ArrayItems {
    this.#expect("{");
    const items: (string | null | ArrayItems)[] = [];
    while (this.#peek() !== "}") {
      items.push(this.#peek() === "{" ? this.array() : this.#element());
      this.#skip(this.#delimiter);
    }
    this.#position += 1;
    return items;
  }

  range(): RangeText {
    const lowerInclusive = this.#peek() === "[";
    this.#position += 1;
    const lower = this.#bound();
    this.#expect(",");
    const upper = this.#bound();
    const upperInclusive = this.#peek() === "]";
    this.#position += 1;
    return { lower, upper, lowerInclusive, upperInclusive };
  }

  ranges(): RangeText[] {
    this.#expect("{");
    const ranges: RangeText[] = [];
    while (this.#peek() !== "}") {
      ranges.push(this.#text.startsWith("empty", this.#position) ? this.#empty() : this.range());
      this.#skip(",");
    }
    return ranges;
  }

  #peek(): string {
    return this.#text.charAt(this.#position);
  }

  #expect(character: string): void {
    if (this.#peek() !== character) {
      throw new FormatError(`expected ${character} at ${String(this.#position)}`);
    }
    this.#position += 1;
  }

  #skip(character: string): void {
    if (this.#peek() === character) {
      this.#position += 1;
    }
  }

  #empty(): "empty" {
    this.#position += "empty".length;
    return "empty";
  }

  #element(): string | null {
    if (this.#peek() === '"') {
      return this.#quoted();
    }
    const text = this.#unquoted(`${this.#delimiter}}`);
    return text === "NULL" ? null : text;
  }

  #bound(): string | null {
    const next = this.#peek();
    if (next === "," || next === ")" || next === "]") {
      return null;
    }
    return next === '"' ? this.#quoted() : this.#unquoted(",)]");
  }

  /** A double-quoted value; a backslash or a doubled quote escapes the next character. */
  #quoted(): string {
    let text = "";
    this.#position += 1;
    while (this.#position < this.#text.length) {
      if (this.#peek() === '"' && this.#text.charAt(this.#position + 1) !== '"') {
        this.#position += 1;
        return text;
      }
      this.#skip(this.#peek() === '"' ? '"' : "\\");
      text += this.#peek();
      this.#position += 1;
    }
    throw new FormatError("unterminated quoted value");
  }

  #unquoted(stops: string): string {
    const start = this.#position;
    while (this.#position < this.#text.length && !stops.includes(this.#peek())) {
      this.#position += 1;
    }
    return this.#text.slice(start, this.#position);
  }
}
