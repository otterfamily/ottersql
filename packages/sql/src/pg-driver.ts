import type { Driver } from "./connection.ts";

const asText = (value: string): string => value;

/**
 * The part of node-postgres's API this file uses: what its `Pool`, `PoolClient` and `Client` have,
 * and Neon's serverless `Pool` and `Client`, which follow node-postgres. Written out rather than
 * imported, so the published types need neither driver's.
 */
export interface PgClient {
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

/** A `Driver` over `pg`, receiving every value as text. */
export function pgDriver(pg: PgClient): Driver {
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
