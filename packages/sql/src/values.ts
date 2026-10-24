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
 * A database connection typed queries run on. Values travel in Postgres's text format both ways
 * so ottersql's codecs decode them the same whatever the driver (ADR 0008).
 */
export interface Connection {
  readonly query: (
    sql: string,
    parameters: readonly (string | null)[],
  ) => Promise<{ readonly rows: readonly (readonly (string | null)[])[] }>;
}
