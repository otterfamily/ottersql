import { PGlite } from "@electric-sql/pglite";

import { shippedExtensions } from "./extensions.ts";
import { cachedEmptySnapshot } from "./snapshot-cache.ts";

// Schemas and query descriptions keep almost no rows, so Postgres's default 128 MB of shared
// buffers would only cost memory. The server log ranks LOG above ERROR, so without raising its
// level every analyzed query tree sent to the client as a notice would also be written there.
const startParams = [
  ...PGlite.defaultStartParams,
  "-c",
  "shared_buffers=16MB",
  "-c",
  "log_min_messages=panic",
];

/**
 * An empty in-process Postgres, restored from a snapshot of a freshly initialised database, because
 * initialising a database takes most of PGlite's startup time and memory, with the `extensions` it
 * ships loaded for `CREATE EXTENSION`. The snapshot is read from disk each time rather than kept,
 * so a long-running content mapper does not hold tens of megabytes for its next restart.
 */
export async function freshDatabase(extensions: readonly string[]): Promise<PGlite> {
  return restoredDatabase(await cachedEmptySnapshot(), extensions);
}

/** An in-process Postgres restored from `snapshot`, with the `extensions` it ships loaded. */
export async function restoredDatabase(
  snapshot: Blob,
  extensions: readonly string[],
): Promise<PGlite> {
  return PGlite.create({
    loadDataDir: snapshot,
    startParams,
    extensions: await shippedExtensions(extensions),
  });
}
