import { PGlite } from "@electric-sql/pglite";

let emptyDataDir: Promise<Blob> | null = null;

/**
 * An empty in-process Postgres. Each one is restored from a snapshot of a freshly initialised
 * database, taken once per process, because initialising a database takes most of PGlite's startup
 * time and every catalog load needs a clean one.
 */
export async function freshDatabase(): Promise<PGlite> {
  emptyDataDir ??= snapshotEmptyDatabase();
  return PGlite.create({ loadDataDir: await emptyDataDir });
}

async function snapshotEmptyDatabase(): Promise<Blob> {
  const db = await PGlite.create();
  try {
    return await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}
