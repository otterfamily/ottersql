/** One statement's result as a driver returns it to ottersql. */
export interface QueryResult {
  /** Each column's name and type oid, in order. */
  readonly fields: readonly { readonly name: string; readonly typeOid: number }[];
  /** Rows as arrays in column order, so columns with the same name survive; values in text format. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * What ottersql needs from a database driver. Values travel in Postgres's text format both ways
 * and each result column carries its type's oid, so ottersql's codecs decode them the same
 * whatever the driver (ADR 0008).
 */
export interface Driver {
  /** Rejects with a `QueryError` when Postgres reports an error, and as the driver does otherwise. */
  readonly query: (sql: string, parameters: readonly (string | null)[]) => Promise<QueryResult>;
}

// From the global registry: a bundle can hold its own copy of this module beside the one an
// adapter imports, and a connection must work with both. The version changes with the shape of
// ConnectionState, so copies that disagree on it do not share connections.
const state: unique symbol = Symbol.for("ottersql.connection.v1");

interface ConnectionState {
  readonly driver: Driver;
  /** What lookups such as type information are cached against. */
  readonly cacheKey: object;
}

/**
 * A database typed queries run on, made from the application's driver by an adapter such as
 * `pgConnection`. It runs no SQL of its own: queries come from `.sql` files.
 */
export interface Connection {
  readonly [state]: ConnectionState;
}

/** A `Connection` over `driver`, for adapters ottersql does not ship. */
export function driverConnection(driver: Driver): Connection {
  return { [state]: { driver, cacheKey: driver } };
}

const connections = new WeakMap<object, Connection>();

/**
 * The connection over `client`, made once with `driver`: the same client gives the same
 * connection, which keeps what it has looked up.
 */
export function clientConnection(client: object, driver: () => Driver): Connection {
  const known = connections.get(client);
  if (known !== undefined) {
    return known;
  }
  const connection = driverConnection(driver());
  connections.set(client, connection);
  return connection;
}

/**
 * Runs `sql` on `connection` as it is, with values as text and rows as arrays of text: no types
 * and no decoding. For tools built on ottersql, such as reading the catalog; applications run
 * typed queries.
 */
export async function rawQuery(
  connection: Connection,
  sql: string,
  parameters: readonly (string | null)[],
): Promise<QueryResult> {
  return connection[state].driver.query(sql, parameters);
}

/** What `connection`'s lookups are cached against. */
export function cacheKey(connection: Connection): object {
  return connection[state].cacheKey;
}
