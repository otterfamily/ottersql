import type { Connection } from "./values.ts";

const asText = (value: string): string => value;

/**
 * The part of node-postgres's API this file uses: what its `Pool`, `PoolClient` and `Client` have,
 * and Neon's serverless `Pool` and `Client`, which follow node-postgres. Written out rather than
 * imported, so the published types need neither driver's.
 */
interface Driver {
  readonly query: (config: {
    readonly text: string;
    readonly values: readonly unknown[];
    readonly rowMode: "array";
    readonly types: { readonly getTypeParser: () => (value: string) => string };
  }) => Promise<{
    readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
    readonly rows: readonly (readonly (string | null)[])[];
  }>;
}

const connections = new WeakMap<Driver, Connection>();

/**
 * A `Connection` over node-postgres, or a driver with its API such as Neon's serverless `Pool`,
 * receiving every value as text. The same driver object gives the same connection, which remembers
 * the types it has looked up; a client checked out of a pool is another object, so wrap the pool
 * itself to share the lookups.
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
      const result = await pg.query({
        text: sql,
        values: parameters,
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
