import { QueryError } from "./query-error.ts";
import { applySettings, retrying, transactionMode } from "./transaction.ts";
import type { TransactionMode, TransactionOptions } from "./transaction.ts";

/** One statement's result as a driver returns it to ottersql. */
export interface QueryResult {
  /** Each column's name and type oid, in order. */
  readonly fields: readonly { readonly name: string; readonly typeOid: number }[];
  /** Rows as arrays in column order, so columns with the same name survive; values in text format. */
  readonly rows: readonly (readonly (string | null)[])[];
  /**
   * The count in the statement's command tag: rows inserted, updated, deleted or merged, or rows
   * a SELECT returned; 0 for a statement whose tag has none, such as CREATE TABLE.
   */
  readonly rowCount: number;
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
   * Runs `run` in a transaction on one connection the driver holds for it: `BEGIN` with `mode`
   * (`transactionModeSql` writes it), then `COMMIT` once `run` resolves or `ROLLBACK` when it
   * rejects, resolving or rejecting as `run` does. Every query `run` makes goes through the
   * `query` it is given, on that connection. The mode belongs in BEGIN rather than a SET
   * statement, which makes poolers such as RDS Proxy pin the connection.
   */
  readonly transaction: <Result>(
    run: (tx: DriverTransaction) => Promise<Result>,
    mode: TransactionMode,
  ) => Promise<Result>;
}

/** A transaction as its driver runs it: statements on its connection, and savepoints in it. */
export interface DriverTransaction {
  readonly query: DriverQuery;
  /**
   * Runs `run` in a savepoint: released once `run` resolves, rolled back to when it rejects,
   * resolving or rejecting as `run` does, or with a `QueryError` when Postgres reports an error for
   * the savepoint itself. A driver with savepoints of its own uses them, since it may track the
   * errors of the statements inside; `sqlTransaction` writes them otherwise.
   */
  readonly savepoint: <Result>(
    run: (savepoint: DriverTransaction) => Promise<Result>,
  ) => Promise<Result>;
}

/**
 * A `DriverTransaction` over `query`, for a driver without savepoints of its own: it sends
 * SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO SAVEPOINT itself. ottersql opens one savepoint of a
 * transaction at a time, so each level needs one name.
 */
export function sqlTransaction(query: DriverQuery, depth = 1): DriverTransaction {
  const name = `ottersql_${String(depth)}`;
  return {
    query,
    savepoint: async (run) => {
      await query(`savepoint ${name}`, []);
      try {
        const result = await run(sqlTransaction(query, depth + 1));
        await query(`release savepoint ${name}`, []);
        return result;
      } catch (error) {
        // Released too, so failed savepoints do not pile up as open subtransactions. A rollback
        // that fails rejects with its own error instead: the savepoint's work was not undone.
        await query(`rollback to savepoint ${name}`, []);
        await query(`release savepoint ${name}`, []);
        throw error;
      }
    },
  };
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
    transaction: async (run, options = {}) => {
      const mode = transactionMode(options);
      return retrying(options.retry, async () =>
        driver.transaction(async (tx) => {
          const scope = openScope(tx, driver);
          try {
            await applySettings(scope.query, options.settings);
            return settled(await run(scope.transaction), scope);
          } finally {
            scope.end();
          }
        }, mode),
      );
    },
  };
}

/** A transaction or a savepoint in progress, and what ottersql tracks about it. */
interface Scope {
  readonly transaction: Transaction;
  /** Runs a statement in the scope, recording the error Postgres reports for it. */
  readonly query: DriverQuery;
  /** Ends the scope; queries on it are refused from then on. */
  readonly end: () => void;
  /** The first error Postgres reported in the scope, after which it can only roll back. */
  readonly failure: () => QueryError | null;
}

/**
 * `result` once the scope's callback has resolved, or the scope's first error: Postgres turns the
 * COMMIT of a transaction a statement failed in into a ROLLBACK, so a callback that caught that
 * error must not look as if it succeeded.
 */
function settled<Result>(result: Result, scope: Scope): Result {
  scope.end();
  const failure = scope.failure();
  if (failure !== null) {
    throw failure;
  }
  return result;
}

const ENDED = "This transaction has ended: run queries on the transaction only inside its callback";
const SAVEPOINT_OPEN =
  "A savepoint of this transaction is open: run queries on it until its callback settles";

/**
 * A transaction or savepoint over the driver's `tx`. It refuses queries once it has ended, and
 * while one of its savepoints is open, since a statement there would run inside the savepoint.
 */
function openScope(tx: DriverTransaction, key: object): Scope {
  let ended = false;
  let savepointOpen = false;
  let failure: QueryError | null = null;
  const open = (): void => {
    if (ended || savepointOpen) {
      throw new Error(ended ? ENDED : SAVEPOINT_OPEN);
    }
  };
  const query: DriverQuery = async (sql, parameters) => {
    open();
    try {
      return await tx.query(sql, parameters);
    } catch (error) {
      failure ??= error instanceof QueryError ? error : null;
      throw error;
    }
  };
  const savepoint: Transaction["savepoint"] = async (run) => {
    open();
    // Set before the first await, so a second savepoint started meanwhile is refused.
    savepointOpen = true;
    try {
      return await inSavepoint(
        tx,
        async (inner) => {
          const scope = openScope(inner, key);
          try {
            return settled(await run(scope.transaction), scope);
          } finally {
            scope.end();
          }
        },
        (error) => {
          failure ??= error instanceof QueryError ? error : null;
        },
      );
    } finally {
      savepointOpen = false;
    }
  };
  return {
    transaction: { [state]: { query, cacheKey: key }, savepoint },
    query,
    end: () => {
      ended = true;
    },
    failure: () => failure,
  };
}

/**
 * Runs `run` in a savepoint of `tx`. An error other than `run`'s is the savepoint's own, such as a
 * rollback to it that failed: what `run` did may not be undone, so `failed` hears of it before the
 * savepoint rejects, for the transaction not to commit as if it were.
 */
async function inSavepoint<Result>(
  tx: DriverTransaction,
  run: (inner: DriverTransaction) => Promise<Result>,
  failed: (error: unknown) => void,
): Promise<Result> {
  // Set in the callback, which TypeScript does not see run before the catch below.
  const rejection: { error?: unknown } = {};
  try {
    return await tx.savepoint(async (inner) => {
      try {
        return await run(inner);
      } catch (error) {
        rejection.error = error;
        throw error;
      }
    });
  } catch (error) {
    if (!("error" in rejection && rejection.error === error)) {
      failed(error);
    }
    throw error;
  }
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
