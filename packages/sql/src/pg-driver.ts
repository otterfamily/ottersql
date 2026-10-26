import type { Driver, DriverQuery } from "./connection.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";

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
    return { query, transaction: async (run) => inTransaction(query, run) };
  }
  return {
    query,
    transaction: async (run) => {
      const client = await pg.connect();
      let broken = false;
      try {
        return await inTransaction(
          pgQuery(async (config) => client.query(config)),
          run,
          () => {
            broken = true;
          },
        );
      } finally {
        // A client whose rollback failed may still be in the transaction, so the pool drops it.
        client.release(broken);
      }
    },
  };
}

function isPool(pg: PgClient | PgPool): pg is PgPool {
  return "totalCount" in pg;
}

/** Runs `run` between BEGIN and COMMIT on `query`'s connection, rolling back when it rejects. */
async function inTransaction<Result>(
  query: DriverQuery,
  run: (query: DriverQuery) => Promise<Result>,
  rollbackFailed?: () => void,
): Promise<Result> {
  await query("begin", []);
  try {
    const result = await run(query);
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
