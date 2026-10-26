/** What Postgres reports about an error, in the fields of its protocol's ErrorResponse. */
export interface QueryErrorFields {
  /** The SQLSTATE, such as `"23505"` for a unique violation. */
  readonly code: string;
  readonly message: string;
  readonly detail: string | null;
  readonly hint: string | null;
  /** The object the error is about, where Postgres names one. */
  readonly schema: string | null;
  readonly table: string | null;
  readonly column: string | null;
  readonly constraint: string | null;
}

/**
 * An error Postgres reported for a statement, the same whatever the driver. The driver's own
 * error is its `cause`. Errors that never reached Postgres, such as a refused connection, are not
 * QueryErrors.
 */
export class QueryError extends Error implements QueryErrorFields {
  override readonly name = "QueryError";
  readonly code: string;
  readonly detail: string | null;
  readonly hint: string | null;
  readonly schema: string | null;
  readonly table: string | null;
  readonly column: string | null;
  readonly constraint: string | null;

  constructor(fields: QueryErrorFields, cause: unknown) {
    super(fields.message, { cause });
    this.code = fields.code;
    this.detail = fields.detail;
    this.hint = fields.hint;
    this.schema = fields.schema;
    this.table = fields.table;
    this.column = fields.column;
    this.constraint = fields.constraint;
  }
}

/**
 * Runs `query`, turning an error the driver reports for Postgres into a QueryError with `read`,
 * which returns `null` for errors that did not come from Postgres.
 */
export async function reportingQueryErrors<Result>(
  query: () => Promise<Result>,
  read: (error: unknown) => QueryErrorFields | null,
): Promise<Result> {
  try {
    return await query();
  } catch (error) {
    const fields = read(error);
    throw fields === null ? error : new QueryError(fields, error);
  }
}

/** A string property of `error`, or `null`. */
export function errorField(error: object, name: string): string | null {
  const value: unknown = Reflect.get(error, name);
  return typeof value === "string" ? value : null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/v;

/**
 * The fields of an error from Postgres as node-postgres's DatabaseError names them, which PGlite's
 * shares, or `null` for any other error.
 */
export function databaseErrorFields(error: unknown): QueryErrorFields | null {
  if (!(error instanceof Error) || !("severity" in error)) {
    return null;
  }
  const code = errorField(error, "code");
  if (code === null || !SQLSTATE.test(code)) {
    return null;
  }
  return {
    code,
    message: error.message,
    detail: errorField(error, "detail"),
    hint: errorField(error, "hint"),
    schema: errorField(error, "schema"),
    table: errorField(error, "table"),
    column: errorField(error, "column"),
    constraint: errorField(error, "constraint"),
  };
}
