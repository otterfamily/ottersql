import { PGlite } from "@electric-sql/pglite";
import { createPostgresDatabase } from "@ottersql/testing";
import { Pool } from "pg";

import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import type { Connection } from "./values.ts";

/**
 * A Vitest fixture with one connection per driver: PGlite in process, and node-postgres to the
 * shared container. Every driver must decode values the same way.
 */
export async function openDrivers(
  {}: object,
  use: (connections: readonly Connection[]) => Promise<void>,
): Promise<void> {
  const db = await PGlite.create();
  const database = await createPostgresDatabase();
  const pool = new Pool({ connectionString: database.url });
  await use([pgliteConnection(db), pgConnection(pool)]);
  await pool.end();
  await database.drop();
  await db.close();
}
