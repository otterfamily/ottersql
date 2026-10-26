import { clientConnection } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { pgDriver } from "./pg-driver.ts";
import type { PgClient } from "./pg-driver.ts";

/**
 * A `Connection` over node-postgres, or a driver with its API such as Neon's serverless `Pool`,
 * receiving every value as text. The same driver object gives the same connection, which remembers
 * the types it has looked up; a client checked out of a pool is another object, so wrap the pool
 * itself to share the lookups.
 */
export function pgConnection(pg: PgClient): Connection {
  return clientConnection(pg, () => pgDriver(pg));
}
