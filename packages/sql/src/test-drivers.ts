import { PGlite } from "@electric-sql/pglite";
import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { createPostgresDatabase, startWebSocketProxy } from "@ottersql/testing";
import { Pool } from "pg";
import postgres from "postgres";

import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { postgresConnection } from "./postgres.ts";
import type { Connection } from "./values.ts";

// The proxy speaks plain WebSocket to Postgres without TLS, which Neon's own hosts never do; and
// the container asks for SCRAM, so the driver cannot send the password with its first messages.
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;

/** Neon's WebSocket `Pool` to the database at `url`, through a proxy closed with the pool. */
async function openNeonPool(
  url: string,
): Promise<{ readonly pool: NeonPool; readonly close: () => Promise<void> }> {
  const proxy = await startWebSocketProxy();
  neonConfig.wsProxy = () => proxy.url;
  const pool = new NeonPool({ connectionString: url });
  return {
    pool,
    close: async () => {
      await pool.end();
      await proxy.stop();
    },
  };
}

/**
 * A Vitest fixture with one connection per driver: PGlite in process, and node-postgres,
 * postgres.js and Neon's serverless driver to the shared container. Every driver must decode values
 * the same way.
 */
export async function openDrivers(
  {}: object,
  use: (connections: readonly Connection[]) => Promise<void>,
): Promise<void> {
  const db = await PGlite.create();
  const database = await createPostgresDatabase();
  const pool = new Pool({ connectionString: database.url });
  const sql = postgres(database.url);
  const neon = await openNeonPool(database.url);
  await use([
    pgliteConnection(db),
    pgConnection(pool),
    postgresConnection(sql),
    pgConnection(neon.pool),
  ]);
  await Promise.all([neon.close(), sql.end(), pool.end()]);
  await database.drop();
  await db.close();
}
