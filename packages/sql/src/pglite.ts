import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { clientConnection } from "./connection.ts";
import type { Connection, Driver, DriverQuery } from "./connection.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";

type Passthrough = (value: string) => string;

const asText: Passthrough = (value) => value;

/**
 * A `Connection` over PGlite, receiving every value as text. The same database gives the same
 * connection, which remembers the types and statements it has looked up.
 */
export function pgliteConnection(db: PGliteInterface): Connection {
  return clientConnection(db, () => textDriver(db));
}

// PGlite takes parsers per type oid, so each statement is described once to learn its oids; arrays
// need their own oid's parser. Describing takes no lock, so it also works inside a transaction,
// which holds PGlite's.
function textDriver(db: PGliteInterface): Driver {
  const passthroughs = new Map<string, Readonly<Record<number, Passthrough>>>();
  const parsersFor = async (sql: string): Promise<Readonly<Record<number, Passthrough>>> => {
    const known = passthroughs.get(sql);
    if (known !== undefined) {
      return known;
    }
    const described = await db.describeQuery(sql);
    const oids = [...described.queryParams, ...described.resultFields].map(
      (field) => field.dataTypeID,
    );
    const parsers = Object.fromEntries(oids.map((oid) => [oid, asText]));
    passthroughs.set(sql, parsers);
    return parsers;
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
    // PGlite's own transaction holds its lock, so no other query runs inside it meanwhile.
    transaction: async (run) =>
      reportingQueryErrors(
        async () => db.transaction(async (tx) => run(queryOn(tx))),
        databaseErrorFields,
      ),
  };
}
