import type { Client, Pool, PoolClient } from "pg";

import type { Connection } from "./values.ts";

const asText = (value: string): string => value;

/** A `Connection` over node-postgres, receiving every value as text. */
export function pgConnection(pg: Pool | PoolClient | Client): Connection {
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
