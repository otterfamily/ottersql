import type { Connection } from "./values.ts";

/** The part of a Bun `SQL` client this file uses; ottersql does not depend on Bun's types. */
export interface BunSql {
  readonly options: { readonly prepare?: boolean };
  readonly unsafe: (
    sql: string,
    parameters: readonly (string | null)[],
  ) => {
    readonly raw: () => Promise<
      readonly (readonly (Uint8Array | null)[])[] & {
        readonly columns?: readonly { readonly name: string; readonly type: number }[];
      }
    >;
  };
}

const connections = new WeakMap<BunSql, Connection>();
const text = new TextDecoder();

/**
 * A `Connection` over Bun's built-in `SQL` client, receiving every value as text. The client must
 * be created with `{ prepare: false }`: Bun receives some types of prepared statements in binary,
 * and ottersql decodes values from text. The same client gives the same connection.
 */
export function bunSqlConnection(sql: BunSql): Connection {
  if (sql.options.prepare !== false) {
    throw new TypeError(
      "Create the Bun SQL client with { prepare: false }: Bun receives prepared statements' values of some types in binary, and ottersql decodes values from text",
    );
  }
  const known = connections.get(sql);
  if (known !== undefined) {
    return known;
  }
  const connection: Connection = {
    query: async (query, parameters) => {
      const result = await sql.unsafe(query, parameters).raw();
      return {
        fields: (result.columns ?? []).map((column) => ({
          name: column.name,
          typeOid: column.type,
        })),
        rows: result.map((row) => row.map((value) => (value === null ? null : text.decode(value)))),
      };
    },
  };
  connections.set(sql, connection);
  return connection;
}
