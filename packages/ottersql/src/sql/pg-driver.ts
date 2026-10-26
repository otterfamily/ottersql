import { sqlTransaction } from "./connection.ts";
import type { Driver, DriverQuery, DriverTransaction } from "./connection.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";
import { transactionModeSql } from "./transaction.ts";
import type { TransactionMode } from "./transaction.ts";

const asText = (value: string): string => value;

/** The query config ottersql sends node-postgres: values back as text, rows as arrays. */
interface PgQueryConfig {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly rowMode: "array";
  readonly types: { readonly getTypeParser: () => (value: string) => string };
}

/** The part of node-postgres's result ottersql reads. */
interface PgResult {
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly rowCount: number | null;
}

/**
 * The part of node-postgres's API this file uses: what its `Client` and `PoolClient` have, and
 * Neon's serverless `Client`, which follows node-postgres. Written out rather than imported, so
 * the published types need neither driver's.
 */
export interface PgClient {
  readonly query: (config: PgQueryConfig) => Promise<PgResult>;
}

/** What node-postgres's `Pool` and Neon's serverless `Pool` have besides `query`. */
export interface PgPool extends PgClient {
  readonly totalCount: number;
  readonly connect: () => Promise<PgClient & { readonly release: (destroy?: boolean) => void }>;
}

/** A `DriverQuery` that runs through `query`, a call taking node-postgres's query config. */
export function pgQuery(query: (config: PgQueryConfig) => Promise<PgResult>): DriverQuery {
  return async (sql, parameters) => {
    const result = await reportingQueryErrors(
      async () =>
        query({
          text: sql,
          values: parameters,
          rowMode: "array",
          types: { getTypeParser: () => asText },
        }),
      databaseErrorFields,
    );
    return {
      fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
    };
  };
}

/**
 * A `Driver` over `pg`, receiving every value as text. A pool's transactions check out a client
 * for their length; a client runs them itself.
 */
export function pgDriver(pg: PgClient | PgPool): Driver {
  const query = pgQuery(async (config) => pg.query(config));
  if (!isPool(pg)) {
    // One connection holds one transaction at a time: a second BEGIN on it only warns, and its
    // statements would join the first. So transactions on a client wait for the one before.
    let previous: Promise<void> = Promise.resolve();
    return {
      query,
      transaction: async (run, mode) => {
        const before = previous;
        const current = (async () => {
          await before;
          return inTransaction({ query, mode }, run);
        })();
        previous = ended(current);
        return current;
      },
    };
  }
  return {
    query,
    transaction: async (run, mode) => {
      const client = await pg.connect();
      let broken = false;
      try {
        const rollbackFailed = (): void => {
          broken = true;
        };
        const onClient = pgQuery(async (config) => client.query(config));
        return await inTransaction({ query: onClient, mode, rollbackFailed }, run);
      } finally {
        // A client whose rollback failed may still be in the transaction, so the pool drops it.
        client.release(broken);
      }
    },
  };
}

/** Resolves once `transaction` has ended, whether it committed or not. */
async function ended(transaction: Promise<unknown>): Promise<void> {
  try {
    await transaction;
  } catch {
    // Its caller gets the error; the next transaction only waits for the connection.
  }
}

function isPool(pg: PgClient | PgPool): pg is PgPool {
  return "totalCount" in pg;
}

/** Runs `run` between BEGIN and COMMIT on `query`'s connection, rolling back when it rejects. */
async function inTransaction<Result>(
  {
    query,
    mode,
    rollbackFailed,
  }: {
    readonly query: DriverQuery;
    readonly mode: TransactionMode;
    readonly rollbackFailed?: () => void;
  },
  run: (tx: DriverTransaction) => Promise<Result>,
): Promise<Result> {
  await query(`begin ${transactionModeSql(mode)}`, []);
  try {
    const result = await run(sqlTransaction(query));
    await query("commit", []);
    return result;
  } catch (error) {
    // The error that ended the transaction is the one to report, not a failed rollback's.
    await query("rollback", []).catch(() => {
      rollbackFailed?.();
    });
    throw error;
  }
}
