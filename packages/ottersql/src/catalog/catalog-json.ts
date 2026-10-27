import { rawQuery } from "../sql/driver.ts";
import type { Connection, Transaction } from "../sql/index.ts";
import type { QualifiedName } from "./model/shared.ts";

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

/** An object's schema and name, such as `{ schema: "pg_catalog", name: "C" }` for a collation. */
export const qualifiedName: Shape<QualifiedName> = (value, path) => {
  const field = fields(value, path);
  return { schema: field("schema", string), name: field("name", string) };
};

/** A catalog query: the rows to select, the order to keep them in, and how to read each. */
export interface CatalogQuery<Row> {
  readonly select: string;
  /** Refers to the columns `select` returns, as `rows.<column>`; left out for a single row. */
  readonly orderBy?: string;
  readonly row: Shape<Row>;
  /** What the rows are, such as `tables`, for the path in an error. */
  readonly label: string;
}

/** A catalog query and what its rows make, to be run with others by `queryCatalog`. */
export interface CatalogRead<Value> {
  readonly label: string;
  /** A scalar subquery that returns the rows as one JSON array. */
  readonly sql: string;
  readonly parse: (json: unknown) => Value;
}

/**
 * `query`, its rows made into a value by `make`. The rows come back as one JSON array, so every
 * driver, PGlite as well, hands them over as text. The order goes into the aggregate, where
 * Postgres keeps it, not into a subquery, where it usually does.
 */
export function catalogRead<Row, Value>(
  query: CatalogQuery<Row>,
  make: (rows: readonly Row[]) => Value,
): CatalogRead<Value> {
  return {
    label: query.label,
    sql: `select coalesce(json_agg(rows${query.orderBy === undefined ? "" : ` order by ${query.orderBy}`}), '[]')
      from (${query.select}) as rows`,
    parse: (json) => make(array(query.row)(json, query.label)),
  };
}

/** What each `CatalogRead` that `queryCatalog` ran makes. Throws for a read it was not given. */
export type CatalogResults = <Value>(read: CatalogRead<Value>) => Value;

/** Catalog reads to run together, and what their results make. */
export interface CatalogReads<Value> {
  readonly reads: readonly CatalogRead<unknown>[];
  /** Asks `results` only for the reads in `reads`. */
  readonly make: (results: CatalogResults) => Value;
}

/**
 * Runs every one of `reads` in a single statement, so reading the catalog of a remote database
 * waits one round trip rather than one for each kind of object. The reads share `parameters`.
 */
export async function queryCatalog(
  connection: Connection | Transaction,
  reads: readonly CatalogRead<unknown>[],
  parameters: readonly string[] = [],
): Promise<CatalogResults> {
  const { rows } = await rawQuery(
    connection,
    `select ${reads.map((read) => `(${read.sql})::text`).join(", ")}`,
    parameters,
  );
  const results = new Map(
    reads.map((read, index) => {
      const text = rows[0]?.[index];
      if (text === null || text === undefined) {
        throw new CatalogShapeError(`the ${read.label} query returned no rows`);
      }
      const json: unknown = JSON.parse(text);
      return [read, json] as const;
    }),
  );
  return (read) => {
    if (!results.has(read)) {
      throw new Error(`the ${read.label} query was not run`);
    }
    return read.parse(results.get(read));
  };
}
