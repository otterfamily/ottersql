import type { IDatabase } from "pg-promise";

import { pgConnection } from "./pg.ts";
import type { Connection } from "./values.ts";

const connections = new WeakMap<IDatabase<unknown>, Connection>();

/**
 * A `Connection` over a pg-promise database object, receiving every value as text. The same object
 * gives the same connection, which remembers the types it has looked up.
 */
export function pgPromiseConnection(db: IDatabase<unknown>): Connection {
  const known = connections.get(db);
  if (known !== undefined) {
    return known;
  }
  // The types pg-promise declares ask for all of node-postgres's type registry, of which
  // node-postgres calls only getTypeParser.
  const registry = db.$config.pgp.pg.types;
  const connection = pgConnection({
    // An object with `text` is a parameterized query to pg-promise: Postgres binds the values,
    // instead of pg-promise formatting them into the SQL.
    query: async (query) =>
      db.result({
        ...query,
        values: [...query.values],
        types: { ...registry, getTypeParser: query.types.getTypeParser },
      }),
  });
  connections.set(db, connection);
  return connection;
}
