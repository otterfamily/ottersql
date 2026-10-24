/** Where in `schema.sql` Postgres reported an error. Both counts start at 1; columns count characters. */
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

/** Turns what PGlite threw while running `schemaSql` into a `SchemaError`, or `null` if it is not a database error. */
export function schemaError(error: unknown, schemaSql: string): SchemaError | null {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return null;
  }
  const offset =
    "position" in error && typeof error.position === "string" ? Number(error.position) : null;
  const position = offset === null ? null : positionAt(schemaSql, offset);
  return new SchemaError(error.message, { code: error.code, position, cause: error });
}

/** Postgres counts the offset in characters (code points), from 1. */
function positionAt(text: string, offset: number): SchemaPosition {
  const before = text[Symbol.iterator]()
    .take(offset - 1)
    .toArray();
  return {
    line: before.filter((character) => character === "\n").length + 1,
    column: before.length - before.lastIndexOf("\n"),
  };
}
