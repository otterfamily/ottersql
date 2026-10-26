import { lineAndColumn, offsetOfPosition } from "../sql/query-file.ts";

/** Where in `schema.sql` Postgres reported an error, as `lineAndColumn` counts it. */
export interface SchemaPosition {
  readonly line: number;
  readonly column: number;
}

/** Postgres rejected `schema.sql`. */
export class SchemaError extends Error {
  override readonly name = "SchemaError";

  /** The SQLSTATE code, such as `42601` for a syntax error. */
  readonly code: string;

  /** `null` when Postgres reports no position, as for a foreign key to a missing table. */
  readonly position: SchemaPosition | null;

  constructor(
    message: string,
    details: {
      readonly code: string;
      readonly position: SchemaPosition | null;
      readonly cause: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.code = details.code;
    this.position = details.position;
  }
}

/**
 * Turns what PGlite threw while running `schemaSql` into a `SchemaError`, with `note` after its
 * message, or `null` if it is not a database error.
 */
export function schemaError(error: unknown, schemaSql: string, note = ""): SchemaError | null {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return null;
  }
  const offset =
    "position" in error && typeof error.position === "string" ? Number(error.position) : null;
  const position =
    offset === null ? null : lineAndColumn(schemaSql, offsetOfPosition(schemaSql, offset));
  return new SchemaError(`${error.message}${note}`, { code: error.code, position, cause: error });
}
