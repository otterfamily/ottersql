import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { clientConnection } from "./connection.ts";
import type { Connection, Driver, DriverQuery } from "./connection.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";
import { transactionModeSql } from "./transaction.ts";

type Passthrough = (value: string) => string;

const asText: Passthrough = (value) => value;

/**
 * A `Connection` over PGlite, receiving every value as text. The same database gives the same
 * connection, which remembers the types it has looked up.
 */
export function pgliteConnection(db: PGliteInterface): Connection {
  return clientConnection(db, () => textDriver(db));
}

// PGlite takes parsers per type oid, so each statement is described to learn its oids; arrays
// need their own oid's parser. Not remembered per statement: a schema change can give the same
// SQL other types, and parsers for the old ones would let PGlite parse the new. Describing takes no
// lock, so it also works inside a transaction, which holds PGlite's.
function textDriver(db: PGliteInterface): Driver {
  const parsersFor = async (sql: string): Promise<Readonly<Record<number, Passthrough>>> => {
    const described = await db.describeQuery(sql);
    const oids = [...described.queryParams, ...described.resultFields].map(
      (field) => field.dataTypeID,
    );
    return Object.fromEntries(oids.map((oid) => [oid, asText]));
  };
  const queryOn =
    (target: Pick<Transaction, "query">): DriverQuery =>
    async (sql, parameters) =>
      reportingQueryErrors(async () => {
        const parsers = await parsersFor(sql);
        const result = await target.query<(string | null)[]>(sql, [...parameters], {
          rowMode: "array",
          parsers,
          serializers: parsers,
        });
        return {
          fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
          rows: result.rows,
          rowCount: result.rowCount ?? 0,
        };
      }, databaseErrorFields);
  return {
    query: queryOn(db),
    // PGlite's own transaction holds its lock, so no other query runs inside it meanwhile. It
    // begins with no mode, so the mode is set first thing; no pooler stands between.
    transaction: async (run, mode) =>
      reportingQueryErrors(
        async () =>
          db.transaction(async (tx) => {
            const modes = transactionModeSql(mode);
            if (modes !== "") {
              await tx.query(`set transaction ${modes}`);
            }
            return run(queryOn(tx));
          }),
        databaseErrorFields,
      ),
  };
}
