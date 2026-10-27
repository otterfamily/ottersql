/**
 * What Postgres reports about an error, in the fields of its protocol's ErrorResponse. `code` and
 * the names of the object the error is about hold no values from rows or parameters, so they are
 * safe to log and to answer with. `message`, `detail` and `hint` can quote values, as a unique
 * violation's detail quotes the key: keep them out of responses, and out of logs that must not
 * hold personal data.
 */
export interface QueryErrorFields {
  /** The SQLSTATE, such as `"23505"` for a unique violation. */
  readonly code: string;
  /** Can quote values, as `invalid input syntax for type uuid: "…"` does. */
  readonly message: string;
  /** Can quote values: `Key (email)=(…) already exists.`, `Failing row contains (…)`. */
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
 * error is its `cause`, which can hold the statement's parameters. Errors that never reached
 * Postgres, such as a refused connection, are not QueryErrors.
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

/** Reads the fields of an error a driver reports for Postgres, or `null` for any other error. */
export type ErrorFieldsReader = (error: unknown) => QueryErrorFields | null;

/** Runs `query`, turning an error the driver reports for Postgres into a QueryError with `read`. */
export async function reportingQueryErrors<Result>(
  query: () => Promise<Result>,
  read: ErrorFieldsReader,
): Promise<Result> {
  try {
    return await query();
  } catch (error) {
    const fields = read(error);
    throw fields === null ? error : new QueryError(fields, error);
  }
}

/** The properties in which a driver's error keeps the fields that drivers name differently. */
export interface ErrorFieldNames {
  readonly code: string;
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly constraint: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/v;

/**
 * A reader of the fields of the errors `isFromPostgres` picks out, at the properties `names` gives.
 * It returns `null` for any other error, and for one whose code is not a SQLSTATE, as a driver's
 * own code for a failure that never reached Postgres is not.
 */
export function errorFieldsReader(
  isFromPostgres: (error: Readonly<Error>) => boolean,
  names: ErrorFieldNames,
): ErrorFieldsReader {
  return (error) => {
    if (!(error instanceof Error) || !isFromPostgres(error)) {
      return null;
    }
    const code = errorField(error, names.code);
    if (code === null || !SQLSTATE.test(code)) {
      return null;
    }
    return {
      code,
      message: error.message,
      detail: errorField(error, "detail"),
      hint: errorField(error, "hint"),
      schema: errorField(error, names.schema),
      table: errorField(error, names.table),
      column: errorField(error, names.column),
      constraint: errorField(error, names.constraint),
    };
  };
}

function errorField(error: object, name: string): string | null {
  const value: unknown = Reflect.get(error, name);
  return typeof value === "string" ? value : null;
}

/**
 * The fields of an error from Postgres as node-postgres's DatabaseError names them, which PGlite's
 * shares, or `null` for any other error.
 */
export const databaseErrorFields: ErrorFieldsReader = errorFieldsReader(
  (error) => "severity" in error,
  {
    code: "code",
    schema: "schema",
    table: "table",
    column: "column",
    constraint: "constraint",
  },
);
