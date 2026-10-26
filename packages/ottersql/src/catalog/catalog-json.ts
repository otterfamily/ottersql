import { rawQuery } from "../sql/driver.ts";
import type { Connection } from "../sql/index.ts";

/**
 * Reads a JSON value the catalog queries return as a `Value`, or throws saying where it is not one.
 * Catalog columns differ between Postgres majors, so a row of an unexpected shape stops reading
 * at the field that is off instead of turning into a wrong catalog.
 */
export type Shape<Value> = (value: unknown, path: string) => Value;

/** The catalog of a database did not have the shape ottersql reads. */
export class CatalogShapeError extends Error {
  override readonly name = "CatalogShapeError";
}

function fail(path: string, expected: string, value: unknown): never {
  throw new CatalogShapeError(
    `${path} is ${value === null ? "null" : typeof value}, not ${expected}`,
  );
}

export const string: Shape<string> = (value, path) =>
  typeof value === "string" ? value : fail(path, "a string", value);

export const number: Shape<number> = (value, path) =>
  typeof value === "number" ? value : fail(path, "a number", value);

export const boolean: Shape<boolean> = (value, path) =>
  typeof value === "boolean" ? value : fail(path, "a boolean", value);

export function nullable<Value>(shape: Shape<Value>): Shape<Value | null> {
  return (value, path) => (value === null ? null : shape(value, path));
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function array<Value>(shape: Shape<Value>): Shape<readonly Value[]> {
  return (value, path) =>
    isList(value)
      ? value.map((item, index) => shape(item, `${path}[${String(index)}]`))
      : fail(path, "an array", value);
}

/** Reads one field of a JSON object with the shape it should have. */
export type Field = <Value>(name: string, shape: Shape<Value>) => Value;

/** Reads the fields of the JSON object `value` one by one, each with the shape it should have. */
export function fields(value: unknown, path: string): Field {
  if (typeof value !== "object" || value === null || isList(value)) {
    return fail(path, "an object", value);
  }
  return (name, shape) => shape(Reflect.get(value, name), `${path}.${name}`);
}

/** A catalog query: the rows to select, the order to keep them in, and how to read each. */
export interface CatalogQuery<Row> {
  readonly select: string;
  /** Refers to the columns `select` returns, as `rows.<column>`; left out for a single row. */
  readonly orderBy?: string;
  readonly parameters?: readonly string[];
  readonly row: Shape<Row>;
  /** What the rows are, such as `tables`, for the path in an error. */
  readonly label: string;
}

/**
 * The rows of `query`, read as `row` describes them. The database returns them as one JSON array,
 * so every driver, PGlite as well, hands them over as text. The order goes into the aggregate,
 * where Postgres keeps it, not into a subquery, where it usually does.
 */
export async function queryRows<Row>(
  connection: Connection,
  query: CatalogQuery<Row>,
): Promise<readonly Row[]> {
  const { rows } = await rawQuery(
    connection,
    `select coalesce(json_agg(rows${query.orderBy === undefined ? "" : ` order by ${query.orderBy}`}), '[]')::text
    from (${query.select}) as rows`,
    query.parameters ?? [],
  );
  const text = rows[0]?.[0];
  if (text === null || text === undefined) {
    throw new CatalogShapeError(`the ${query.label} query returned no rows`);
  }
  return array(query.row)(JSON.parse(text), query.label);
}
