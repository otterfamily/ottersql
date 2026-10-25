import { PGlite } from "@electric-sql/pglite";
import { createPostgresDatabase } from "@ottersql/testing";
import { Pool } from "pg";
import postgres from "postgres";

import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { postgresConnection } from "./postgres.ts";
import type { Connection } from "./values.ts";

/**
 * A Vitest fixture with one connection per driver: PGlite in process, and node-postgres and
 * postgres.js to the shared container. Every driver must decode values the same way.
 */
export async function openDrivers(
  {}: object,
  use: (connections: readonly Connection[]) => Promise<void>,
): Promise<void> {
  const db = await PGlite.create();
  const database = await createPostgresDatabase();
  const pool = new Pool({ connectionString: database.url });
  const sql = postgres(database.url);
  await use([pgliteConnection(db), pgConnection(pool), postgresConnection(sql)]);
  await sql.end();
  await pool.end();
  await database.drop();
  await db.close();
}
