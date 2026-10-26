import type { IDatabase } from "pg-promise";

import { clientConnection } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { pgDriver } from "./pg-driver.ts";

/**
 * A `Connection` over a pg-promise database object, receiving every value as text. The same object
 * gives the same connection, which remembers the types it has looked up.
 */
export function pgPromiseConnection(db: IDatabase<unknown>): Connection {
  // The types pg-promise declares ask for all of node-postgres's type registry, of which
  // node-postgres calls only getTypeParser.
  const registry = db.$config.pgp.pg.types;
  return clientConnection(db, () =>
    pgDriver({
      // An object with `text` is a parameterized query to pg-promise: Postgres binds the values,
      // instead of pg-promise formatting them into the SQL.
      query: async (query) =>
        db.result({
          ...query,
          values: [...query.values],
          types: { ...registry, getTypeParser: query.types.getTypeParser },
        }),
    }),
  );
}
