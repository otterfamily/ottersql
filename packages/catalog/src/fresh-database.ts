import { PGlite } from "@electric-sql/pglite";

import { cachedEmptySnapshot } from "./snapshot-cache.ts";

let emptyDataDir: Promise<Blob> | null = null;

// Schemas and query descriptions keep almost no rows, so Postgres's default 128 MB of shared
// buffers would only cost memory.
const startParams = [...PGlite.defaultStartParams, "-c", "shared_buffers=16MB"];

/**
 * An empty in-process Postgres, restored from a snapshot of a freshly initialised database, because
 * initialising a database takes most of PGlite's startup time and memory.
 */
export async function freshDatabase(): Promise<PGlite> {
  return PGlite.create({ loadDataDir: await emptySnapshot(), startParams });
}

/** A failed snapshot is forgotten, so the next load tries again instead of failing for good. */
async function emptySnapshot(): Promise<Blob> {
  emptyDataDir ??= cachedEmptySnapshot();
  try {
    return await emptyDataDir;
  } catch (error) {
    emptyDataDir = null;
    throw error;
  }
}
