import { decodeValue } from "./decode.ts";
import { encodeParameter } from "./encode.ts";
import { typeInfos } from "./type-info.ts";
import type { Connection } from "./values.ts";

/** A query's arguments: the connection, then its parameters unless it has none (`undefined`). */
export type QueryArguments<Params> = Params extends undefined
  ? [connection: Connection]
  : [connection: Connection, params: Params];

/** A query from a `.sql` file, typed by the content mapper and run on any `Connection`. */
export interface TypedQuery<Params, Row> {
  (...args: QueryArguments<Params>): Promise<Row[]>;
  /** The only row; rejects unless the query returns exactly one. */
  readonly one: (...args: QueryArguments<Params>) => Promise<Row>;
  /** The only row, or `null` for none; rejects when the query returns more than one. */
  readonly maybeOne: (...args: QueryArguments<Params>) => Promise<Row | null>;
}

/** Parameters by name and a row by column name, as `defineQuery` sees them before the content mapper types them. */
export type QueryParams = Readonly<Record<string, unknown>>;
export type QueryRow = Readonly<Record<string, unknown>>;

/**
 * Wraps SQL with `$n` placeholders so it runs with named parameters and decoded rows. The content
 * mapper declares each query's precise types; at run time they are plain records.
 */
export function defineQuery(
  sql: string,
  parameterNames: readonly string[],
): TypedQuery<QueryParams | undefined, QueryRow> {
  type Params = QueryParams;
  type Row = QueryRow;
  const run = async (connection: Connection, params?: Params): Promise<Row[]> => {
    const values = parameterNames.map((name) => encodeParameter(params?.[name] ?? null));
    const result = await connection.query(sql, values);
    const types = await typeInfos(
      connection,
      result.fields.map((field) => field.typeOid),
    );
    return result.rows.map((row) => {
      const entries = result.fields.map((field, index) => {
        const type = types.get(field.typeOid) ?? { kind: "text" as const };
        return [field.name, decodeValue(row[index] ?? null, type)] as const;
      });
      return Object.fromEntries(entries);
    });
  };
  return Object.assign(run, {
    one: async (connection: Connection, params?: Params): Promise<Row> => {
      const rows = await run(connection, params);
      const [row] = rows;
      if (row === undefined || rows.length > 1) {
        throw new Error(`expected exactly one row, got ${String(rows.length)}`);
      }
      return row;
    },
    maybeOne: async (connection: Connection, params?: Params): Promise<Row | null> => {
      const rows = await run(connection, params);
      if (rows.length > 1) {
        throw new Error(`expected at most one row, got ${String(rows.length)}`);
      }
      return rows[0] ?? null;
    },
  });
}
