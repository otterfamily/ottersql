/** An `interval`, kept as Postgres stores it so mixed signs such as `1 mon -3 days` survive (ADR 0008). */
export interface Interval {
  readonly months: number;
  readonly days: number;
  readonly microseconds: bigint;
}

/** A range value. An unbounded side is `null`. */
export type Range<Bound> =
  | "empty"
  | {
      readonly lower: Bound | null;
      readonly upper: Bound | null;
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    };

// From the global registry, as a connection's state is: a bundle can hold its own copy of this
// module beside the one an application imports `json` from, and the value must work with both.
const jsonValue: unique symbol = Symbol.for("ottersql.json");

/**
 * A value to send to a json or jsonb parameter, made by `json`. Wrapping says the value is JSON:
 * without the types of parameters at run time, a bare string or array would be sent as Postgres
 * text or an array.
 */
export interface Json {
  readonly [jsonValue]: unknown;
}

/** Marks `value` for a json or jsonb parameter; it is sent as `JSON.stringify(value)`. */
export function json(value: unknown): Json {
  return { [jsonValue]: value };
}

/** The JSON text of `value` when `json` made it, or `undefined`. */
export function jsonText(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && jsonValue in value
    ? JSON.stringify(value[jsonValue])
    : undefined;
}
