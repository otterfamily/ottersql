import { retrying, startTransaction } from "./transaction.ts";
import type { TransactionOptions } from "./transaction.ts";

/** One statement's result as a driver returns it to ottersql. */
export interface QueryResult {
  /** Each column's name and type oid, in order. */
  readonly fields: readonly { readonly name: string; readonly typeOid: number }[];
  /** Rows as arrays in column order, so columns with the same name survive; values in text format. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/** Runs one statement. Rejects with a `QueryError` when Postgres reports an error. */
export type DriverQuery = (
  sql: string,
  parameters: readonly (string | null)[],
) => Promise<QueryResult>;

/**
 * What ottersql needs from a database driver. Values travel in Postgres's text format both ways
 * and each result column carries its type's oid, so ottersql's codecs decode them the same
 * whatever the driver (ADR 0008).
 */
export interface Driver {
  readonly query: DriverQuery;
  /**
   * Runs `run` in a transaction on one connection the driver holds for it: `BEGIN`, then `COMMIT`
   * once `run` resolves or `ROLLBACK` when it rejects, resolving or rejecting as `run` does. Every
   * query `run` makes goes through the `query` it is given, on that connection.
   */
  readonly transaction: <Result>(run: (query: DriverQuery) => Promise<Result>) => Promise<Result>;
}

// From the global registry: a bundle can hold its own copy of this module beside the one an
// adapter imports, and a connection must work with both. The version changes with the shape of
// ConnectionState, so copies that disagree on it do not share connections.
const state: unique symbol = Symbol.for("ottersql.connection.v1");

interface ConnectionState {
  readonly query: DriverQuery;
  /** What lookups such as type information are cached against, shared with its transactions. */
  readonly cacheKey: object;
}

/**
 * A database typed queries run on, made from the application's driver by an adapter such as
 * `pgConnection`. It runs no SQL of its own: queries come from `.sql` files.
 */
export interface Connection {
  readonly [state]: ConnectionState;
  /**
   * Runs `run` in a transaction: it commits once `run` resolves and rolls back when it rejects,
   * resolving or rejecting as `run` does. Queries in it run on `tx`; the connection itself stays
   * outside the transaction.
   */
  readonly transaction: <Result>(
    run: (tx: Transaction) => Promise<Result>,
    options?: TransactionOptions,
  ) => Promise<Result>;
}

/** A transaction in progress, which typed queries run in. It ends when its callback settles. */
export interface Transaction {
  readonly [state]: ConnectionState;
  /**
   * Runs `run` after a savepoint: when it rejects, only what it did is undone, and the transaction
   * goes on. Resolves or rejects as `run` does.
   */
  readonly savepoint: <Result>(run: (sp: Transaction) => Promise<Result>) => Promise<Result>;
}

/** A `Connection` over `driver`, for adapters ottersql does not ship. */
export function driverConnection(driver: Driver): Connection {
  return {
    [state]: { query: driver.query, cacheKey: driver },
    transaction: async (run, options = {}) =>
      retrying(options.retry, async () =>
        driver.transaction(async (query) => {
          const tx = openTransaction(query, driver, 1);
          try {
            await startTransaction(query, options);
            return await run(tx.transaction);
          } finally {
            tx.end();
          }
        }),
      ),
  };
}

/** A transaction, or a savepoint `depth` levels in, that refuses queries once it has ended. */
function openTransaction(
  query: DriverQuery,
  key: object,
  depth: number,
): { readonly transaction: Transaction; readonly end: () => void } {
  let ended = false;
  const guarded: DriverQuery = async (sql, parameters) => {
    if (ended) {
      throw new Error(
        "This transaction has ended: run queries on the transaction only inside its callback",
      );
    }
    return query(sql, parameters);
  };
  const name = `ottersql_${String(depth)}`;
  const transaction: Transaction = {
    [state]: { query: guarded, cacheKey: key },
    savepoint: async (run) => {
      await guarded(`savepoint ${name}`, []);
      const inner = openTransaction(guarded, key, depth + 1);
      try {
        const result = await run(inner.transaction);
        await guarded(`release savepoint ${name}`, []);
        return result;
      } catch (error) {
        await guarded(`rollback to savepoint ${name}`, []);
        throw error;
      } finally {
        inner.end();
      }
    },
  };
  return {
    transaction,
    end: () => {
      ended = true;
    },
  };
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
  connection: Connection | Transaction,
  sql: string,
  parameters: readonly (string | null)[],
): Promise<QueryResult> {
  return connection[state].query(sql, parameters);
}

/** What `connection`'s lookups are cached against. */
export function cacheKey(connection: Connection | Transaction): object {
  return connection[state].cacheKey;
}
