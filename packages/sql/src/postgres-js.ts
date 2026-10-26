import type { Sql } from "postgres";

import { clientConnection } from "./connection.ts";
import type { Connection, Driver } from "./connection.ts";

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
    query: async (text, parameters) => {
      const values = parameters.map((value) =>
        value === null ? null : sql.typed(value, UNKNOWN_OID),
      );
      const result = await sql.unsafe(text, values).raw();
      const rows: readonly (readonly (Buffer | null)[])[] = result;
      return {
        fields: (result.columns ?? []).map((column) => ({
          name: column.name,
          typeOid: column.type,
        })),
        rows: rows.map((row) => row.map((value) => (value === null ? null : value.toString()))),
      };
    },
  };
}
