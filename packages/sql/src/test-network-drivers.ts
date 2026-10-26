import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { startWebSocketProxy } from "@ottersql/testing";
import { Pool } from "pg";
import pgPromise from "pg-promise";
import postgres from "postgres";

import { pgPromiseConnection } from "./pg-promise.ts";
import { pgConnection } from "./pg.ts";
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

/** A connection through each driver that reaches the database at `url` over the network. */
export async function openNetworkDrivers(
  url: string,
): Promise<{ readonly connections: readonly Connection[]; readonly close: () => Promise<void> }> {
  const pool = new Pool({ connectionString: url });
  const sql = postgres(url);
  const promised = pgPromise()(url);
  const neon = await openNeonPool(url);
  return {
    connections: [
      pgConnection(pool),
      postgresConnection(sql),
      pgPromiseConnection(promised),
      pgConnection(neon.pool),
    ],
    close: async () => {
      await Promise.all([neon.close(), promised.$pool.end(), sql.end(), pool.end()]);
    },
  };
}
