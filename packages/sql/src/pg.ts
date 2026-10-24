import type { Client, Pool, PoolClient } from "pg";

import type { Connection } from "./values.ts";

const asText = (value: string): string => value;

type Driver = Pool | PoolClient | Client;

const connections = new WeakMap<Driver, Connection>();

/**
 * A `Connection` over node-postgres, receiving every value as text. The same driver object gives
 * the same connection, which remembers the types it has looked up; a client checked out of a pool
 * is another object, so wrap the pool itself to share the lookups.
 */
export function pgConnection(pg: Driver): Connection {
  const known = connections.get(pg);
  if (known !== undefined) {
    return known;
  }
  const connection = textConnection(pg);
  connections.set(pg, connection);
  return connection;
}

function textConnection(pg: Driver): Connection {
  return {
    query: async (sql, parameters) => {
      const result = await pg.query<(string | null)[]>({
        text: sql,
        values: [...parameters],
        rowMode: "array",
        types: { getTypeParser: () => asText },
      });
      return {
        fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
        rows: result.rows,
      };
    },
  };
}
