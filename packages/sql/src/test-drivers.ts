import { PGlite } from "@electric-sql/pglite";
import { createPostgresDatabase } from "@ottersql/testing";

import { pgliteConnection } from "./pglite.ts";
import { openNetworkDrivers } from "./test-network-drivers.ts";
import type { Connection } from "./values.ts";

/**
 * A Vitest fixture with one connection per driver: PGlite in process, and node-postgres,
 * postgres.js, pg-promise and Neon's serverless driver to the shared container. Every driver must
 * decode values the same way.
 */
export async function openDrivers(
  {}: object,
  use: (connections: readonly Connection[]) => Promise<void>,
): Promise<void> {
  const db = await PGlite.create();
  const database = await createPostgresDatabase();
  const network = await openNetworkDrivers(database.url);
  await use([pgliteConnection(db), ...network.connections]);
  await network.close();
  await database.drop();
  await db.close();
}
