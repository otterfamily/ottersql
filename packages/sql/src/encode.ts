import { byteaText } from "./bytea.ts";
import { arrayLiteral, intervalLiteral, rangeLiteral } from "./literals.ts";
import type { ArrayItems } from "./literals.ts";
import { Json } from "./values.ts";
import type { Interval } from "./values.ts";

/**
 * Encodes a parameter in Postgres's text input format, by the kind of JavaScript value: parameter
 * types are not known at run time, so JSON must be wrapped with `json(...)` (see `Json`).
 */
export function encodeParameter(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return arrayLiteral(encodeItems(value));
  }
  return encodeScalar(value);
}

function encodeItems(values: readonly unknown[]): ArrayItems {
  return values.map((value) =>
    Array.isArray(value) ? encodeItems(value) : encodeParameter(value),
  );
}

function encodeScalar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "bigint" || typeof value === "boolean"
    ? String(value)
    : encodeObject(value);
}

const objectEncoders: readonly ((value: unknown) => string | undefined)[] = [
  (value) => (value instanceof Json ? JSON.stringify(value.value) : undefined),
  (value) => (value instanceof Uint8Array ? byteaText(value) : undefined),
  (value) => (isTemporal(value) ? value.toString() : undefined),
  (value) => (isInterval(value) ? intervalLiteral(value) : undefined),
  (value) =>
    isRange(value)
      ? rangeLiteral({ ...value, lower: encodeBound(value.lower), upper: encodeBound(value.upper) })
      : undefined,
];

function encodeObject(value: unknown): string {
  for (const encode of objectEncoders) {
    const text = encode(value);
    if (text !== undefined) {
      return text;
    }
  }
  throw new TypeError(`cannot send ${String(value)} as a Postgres parameter`);
}

function encodeBound(bound: unknown): string | null {
  return bound === null ? null : encodeScalar(bound);
}

function isTemporal(
  value: unknown,
): value is Temporal.Instant | Temporal.PlainDate | Temporal.PlainDateTime | Temporal.PlainTime {
  return (
    value instanceof Temporal.Instant ||
    value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainDateTime ||
    value instanceof Temporal.PlainTime
  );
}

function isInterval(value: unknown): value is Interval {
  return (
    typeof value === "object" &&
    value !== null &&
    "microseconds" in value &&
    "months" in value &&
    "days" in value
  );
}

function isRange(value: unknown): value is {
  readonly lower: unknown;
  readonly upper: unknown;
  readonly lowerInclusive: boolean;
  readonly upperInclusive: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "lowerInclusive" in value &&
    "upperInclusive" in value
  );
}
