import { clientConnection } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { pgDriver } from "./pg-driver.ts";
import type { PgClient, PgPool } from "./pg-driver.ts";

/**
 * A `Connection` over node-postgres, or a driver with its API such as Neon's serverless `Pool`,
 * receiving every value as text. Pass the pool: each transaction checks out a client for its
 * length. A single client runs transactions itself, so queries others send on it meanwhile join
 * them. The same object gives the same connection, which remembers the types it has looked up.
 */
export function pgConnection(pg: PgPool | PgClient): Connection {
  return clientConnection(pg, () => pgDriver(pg));
}
