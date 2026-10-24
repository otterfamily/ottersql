import { decodeColumn } from "./decode.ts";
import { encodeParameter } from "./encode.ts";
import { typeInfos } from "./type-info.ts";
import type { TypeInfo } from "./type-info.ts";
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

const textType: TypeInfo = { kind: "text" };

/**
 * Why rows cannot have these columns as properties, or `null` when they can: a repeated name would
 * lose all but one value, and `__proto__` would replace the row's prototype.
 */
export function columnNamesProblem(names: readonly string[]): string | null {
  if (names.includes("__proto__")) {
    return 'Column "__proto__" cannot be a property of a row; rename it with AS';
  }
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  return duplicate === undefined
    ? null
    : `Column "${duplicate}" appears more than once; give each column its own name with AS`;
}

/** Only `null` means NULL: a forgotten parameter would otherwise match nothing, silently. */
function parameterValue(params: QueryParams | undefined, name: string): unknown {
  const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
  if (value === undefined) {
    throw new TypeError(`Parameter "${name}" is missing; pass null for NULL`);
  }
  return value;
}

/** Assigning properties in a loop is several times faster than `Object.fromEntries`; `columnNamesProblem` keeps it safe. */
function decodeRow(
  row: readonly (string | null)[],
  columns: readonly { readonly name: string; readonly type: TypeInfo }[],
): QueryRow {
  const decoded: Record<string, unknown> = {};
  for (const [index, { name, type }] of columns.entries()) {
    decoded[name] = decodeColumn(name, row[index] ?? null, type);
  }
  return decoded;
}

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
    const values = parameterNames.map((name) => encodeParameter(parameterValue(params, name)));
    const result = await connection.query(sql, values);
    const problem = columnNamesProblem(result.fields.map(({ name }) => name));
    if (problem !== null) {
      throw new TypeError(problem);
    }
    const types = await typeInfos(
      connection,
      result.fields.map((field) => field.typeOid),
    );
    const columns = result.fields.map((field) => ({
      name: field.name,
      type: types.get(field.typeOid) ?? textType,
    }));
    return result.rows.map((row) => decodeRow(row, columns));
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
