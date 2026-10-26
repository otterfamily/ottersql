import type { Sql, TransactionSql } from "postgres";

import { clientConnection } from "./connection.ts";
import type { Connection, Driver, DriverQuery, DriverTransaction } from "./connection.ts";
import { errorField, reportingQueryErrors } from "./query-error.ts";
import type { QueryErrorFields } from "./query-error.ts";
import { transactionModeSql } from "./transaction.ts";

/**
 * A `Connection` over postgres.js, receiving every value as text. The same client gives the same
 * connection, which remembers the types it has looked up. Prepared statements follow the client's
 * own `prepare` option.
 */
export function postgresJsConnection(sql: Sql): Connection {
  return clientConnection(sql, () => textDriver(sql));
}

/** Postgres's `unknown` type: the parameter's type is left to Postgres, as with pg's text values. */
const UNKNOWN_OID = 705;

// `raw()` skips postgres.js's parsers and gives each value's text as Postgres sent it. Parameters
// are typed `unknown` because postgres.js otherwise serializes them again by the type Postgres
// infers, which breaks the text ottersql already wrote (JSON would be quoted twice, booleans and
// timestamps rewritten).
function textDriver(sql: Sql): Driver {
  return {
    query: queryOn(sql),
    // Wrapped, because postgres.js awaits every element of an array a transaction resolves with.
    transaction: async (run, mode) => {
      const { result } = await reportingQueryErrors(
        async () =>
          sql.begin(transactionModeSql(mode), async (tx) => ({
            result: await run(transactionOn(tx)),
          })),
        postgresErrorFields,
      );
      return result;
    },
  };
}

/**
 * A transaction on postgres.js's `tx`, with postgres.js's own savepoints: it tracks the errors of
 * the statements in a transaction and fails the transaction for one a savepoint did not hold.
 */
function transactionOn(tx: TransactionSql): DriverTransaction {
  return {
    query: queryOn(tx),
    savepoint: async (run) => {
      const { result } = await tx.savepoint(async (sp) => ({
        result: await run(transactionOn(sp)),
      }));
      return result;
    },
  };
}

function queryOn(sql: Sql | TransactionSql): DriverQuery {
  return async (text, parameters) => {
    const values = parameters.map((value) =>
      value === null ? null : sql.typed(value, UNKNOWN_OID),
    );
    const result = await reportingQueryErrors(
      async () => sql.unsafe(text, values).raw(),
      postgresErrorFields,
    );
    const rows: readonly (readonly (Buffer | null)[])[] = result;
    return {
      fields: (result.columns ?? []).map((column) => ({
        name: column.name,
        typeOid: column.type,
      })),
      rows: rows.map((row) => row.map((value) => (value === null ? null : value.toString()))),
      rowCount: result.count ?? 0,
    };
  };
}

/** The fields of postgres.js's PostgresError, which it names with a `_name` suffix. */
function postgresErrorFields(error: unknown): QueryErrorFields | null {
  if (!(error instanceof Error) || error.name !== "PostgresError") {
    return null;
  }
  const code = errorField(error, "code");
  return code === null
    ? null
    : {
        code,
        message: error.message,
        detail: errorField(error, "detail"),
        hint: errorField(error, "hint"),
        schema: errorField(error, "schema_name"),
        table: errorField(error, "table_name"),
        column: errorField(error, "column_name"),
        constraint: errorField(error, "constraint_name"),
      };
}
