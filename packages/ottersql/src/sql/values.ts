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

/**
 * A value to send to a json or jsonb parameter. Wrapping says the value is JSON: without the types
 * of parameters at run time, a bare string or array would be sent as Postgres text or an array.
 */
export class Json {
  readonly value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }
}

/** Marks `value` for a json or jsonb parameter; it is sent as `JSON.stringify(value)`. */
export function json(value: unknown): Json {
  return new Json(value);
}
