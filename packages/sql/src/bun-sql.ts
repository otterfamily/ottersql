import { clientConnection } from "./connection.ts";
import type { Connection, DriverQuery } from "./connection.ts";
import { errorField, reportingQueryErrors } from "./query-error.ts";
import type { QueryErrorFields } from "./query-error.ts";

/** The part of a Bun `SQL` transaction this file uses. */
interface BunSqlTransaction {
  readonly unsafe: (
    sql: string,
    parameters: readonly (string | null)[],
  ) => {
    readonly raw: () => Promise<
      readonly (readonly (Uint8Array | null)[])[] & {
        readonly columns?: readonly { readonly name: string; readonly type: number }[];
        readonly count: number | null;
      }
    >;
  };
}

/** The part of a Bun `SQL` client this file uses; ottersql does not depend on Bun's types. */
export interface BunSql extends BunSqlTransaction {
  readonly options: { readonly prepare?: boolean };
  readonly begin: <Result>(run: (tx: BunSqlTransaction) => Promise<Result>) => Promise<Result>;
}

const text = new TextDecoder();

/**
 * A `Connection` over Bun's built-in `SQL` client, receiving every value as text. The client must
 * be created with `{ prepare: false }`: Bun receives some types of prepared statements in binary,
 * and ottersql decodes values from text. The same client gives the same connection.
 */
export function bunSqlConnection(sql: BunSql): Connection {
  if (sql.options.prepare !== false) {
    throw new TypeError(
      "Create the Bun SQL client with { prepare: false }: Bun receives prepared statements' values of some types in binary, and ottersql decodes values from text",
    );
  }
  return clientConnection(sql, () => ({
    query: queryOn(sql),
    // Wrapped, because Bun takes an array a transaction resolves with for queries to run.
    transaction: async (run) => {
      const { result } = await reportingQueryErrors(
        async () => sql.begin(async (tx) => ({ result: await run(queryOn(tx)) })),
        bunErrorFields,
      );
      return result;
    },
  }));
}

function queryOn(sql: BunSqlTransaction): DriverQuery {
  return async (query, parameters) => {
    const result = await reportingQueryErrors(
      async () => sql.unsafe(query, parameters).raw(),
      bunErrorFields,
    );
    return {
      fields: (result.columns ?? []).map((column) => ({
        name: column.name,
        typeOid: column.type,
      })),
      rows: result.map((row) => row.map((value) => (value === null ? null : text.decode(value)))),
      rowCount: result.count ?? 0,
    };
  };
}

/** The fields of Bun's PostgresError, whose `code` is Bun's own and `errno` the SQLSTATE. */
function bunErrorFields(error: unknown): QueryErrorFields | null {
  if (!(error instanceof Error) || error.name !== "PostgresError") {
    return null;
  }
  const code = errorField(error, "errno");
  return code === null
    ? null
    : {
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
