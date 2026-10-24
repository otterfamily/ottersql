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
 * A database connection typed queries run on. Values travel in Postgres's text format both ways,
 * and each result column carries its type's oid, so ottersql's codecs decode them the same whatever
 * the driver (ADR 0008). Rows are arrays in column order, so columns with the same name survive.
 */
export interface Connection {
  readonly query: (
    sql: string,
    parameters: readonly (string | null)[],
  ) => Promise<{
    readonly fields: readonly { readonly name: string; readonly typeOid: number }[];
    readonly rows: readonly (readonly (string | null)[])[];
  }>;
}

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
