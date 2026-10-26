import type { IDatabase } from "pg-promise";

import { clientConnection } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { pgQuery } from "./pg-driver.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";

/**
 * A `Connection` over a pg-promise database object, receiving every value as text. Transactions
 * run in pg-promise's own (`db.tx`). The same object gives the same connection, which remembers
 * the types it has looked up.
 */
export function pgPromiseConnection(db: IDatabase<unknown>): Connection {
  // The types pg-promise declares ask for all of node-postgres's type registry, of which
  // node-postgres calls only getTypeParser.
  const registry = db.$config.pgp.pg.types;
  // An object with `text` is a parameterized query to pg-promise: Postgres binds the values,
  // instead of pg-promise formatting them into the SQL.
  const queryOn = (context: Pick<IDatabase<unknown>, "result">) =>
    pgQuery(async (config) =>
      context.result({
        ...config,
        values: [...config.values],
        types: { ...registry, getTypeParser: config.types.getTypeParser },
      }),
    );
  return clientConnection(db, () => ({
    query: queryOn(db),
    transaction: async (run) =>
      reportingQueryErrors(
        async () => db.tx(async (task) => run(queryOn(task))),
        databaseErrorFields,
      ),
  }));
}
