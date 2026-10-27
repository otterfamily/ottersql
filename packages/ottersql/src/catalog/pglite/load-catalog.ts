import type { PGlite } from "@electric-sql/pglite";

import { pgliteConnection } from "../../sql/pglite.ts";
import type { Catalog } from "../model/catalog.ts";
import { readCatalog } from "../read-catalog.ts";
import type { CatalogOptions } from "../read-catalog.ts";
import { extensionsFor, skippedNote, withoutMissing } from "./extensions.ts";
import { freshDatabase, restoredDatabase } from "./fresh-database.ts";
import { schemaError } from "./schema-error.ts";
import { cachedSchemaSnapshot, saveSchemaSnapshot, schemaSnapshotKey } from "./snapshot-cache.ts";

/** A throwaway in-process Postgres with a schema applied, and the catalog read from it. */
export interface OpenSchema {
  readonly catalog: Catalog;
  /** Queries run here see the schema; the database is discarded on `close`. */
  readonly database: PGlite;
  /** Reads the catalog of `database` as it is now, after statements have changed it. */
  readonly readCatalog: () => Promise<Catalog>;
  /**
   * Runs `sql` in `database` as the schema was run: creating an extension PGlite lacks is skipped,
   * and an error says so. Its extensions must have been named in `alsoRuns` when opening.
   */
  readonly run: (sql: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Runs `schemaSql` in a throwaway in-process Postgres, reads its catalog and keeps the database
 * open for further queries. PGlite starts with the extensions that `schemaSql` and `alsoRuns`, SQL
 * to be run later, create; creating one it does not ship is skipped, which an extension that no
 * object uses, such as pgaudit, never notices. Rejects with a `SchemaError` when Postgres rejects
 * the SQL.
 *
 * With `cache`, the database as `schemaSql` leaves it is kept in the user's cache directory, and a
 * later open with the same SQL restores it instead of running the SQL again: for a large schema
 * that is most of the time opening takes. Only the database is kept, which depends on nothing but
 * PGlite and the SQL; the catalog is always read from it, with `options` saying what to leave out.
 */
export async function openSchema(
  schemaSql: string,
  {
    alsoRuns = [],
    cache = false,
    ...options
  }: CatalogOptions & { readonly alsoRuns?: readonly string[]; readonly cache?: boolean } = {},
): Promise<OpenSchema> {
  const sources = [schemaSql, ...alsoRuns];
  const { shipped, missing } = await extensionsFor(sources);
  const { database, key, restored } = await startDatabase(sources, shipped, cache);
  const run = async (sql: string): Promise<void> => {
    await database.exec(withoutMissing(sql, missing)).catch((error: unknown) => {
      throw schemaError(error, sql, skippedNote(missing)) ?? error;
    });
  };
  try {
    if (!restored) {
      await applySchema({ database, run, schemaSql, key });
    }
    return await opened(database, run, options);
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** A database restored with the schema from the cache, or a fresh one to run it in. */
async function startDatabase(
  sources: readonly string[],
  shipped: readonly string[],
  cache: boolean,
): Promise<{ readonly database: PGlite; readonly key: string | null; readonly restored: boolean }> {
  const key = cache ? await schemaSnapshotKey(sources) : null;
  const cached = key === null ? null : await cachedSchemaSnapshot(key);
  // A snapshot removed or replaced while it was being read only costs running the schema again.
  const restored =
    cached === null ? null : await restoredDatabase(cached, shipped).catch(() => null);
  return restored === null
    ? { database: await freshDatabase(shipped), key, restored: false }
    : { database: restored, key, restored: true };
}

/** Runs the schema in a fresh database, and keeps the result under `key` when there is one. */
async function applySchema(fresh: {
  readonly database: PGlite;
  readonly run: (sql: string) => Promise<void>;
  readonly schemaSql: string;
  readonly key: string | null;
}): Promise<void> {
  await fresh.run(fresh.schemaSql);
  if (fresh.key !== null) {
    await saveSchemaSnapshot(fresh.key, await fresh.database.dumpDataDir("none"));
  }
}

async function opened(
  database: PGlite,
  run: (sql: string) => Promise<void>,
  options: CatalogOptions,
): Promise<OpenSchema> {
  const connection = pgliteConnection(database);
  return {
    catalog: await readCatalog(connection, options),
    database,
    readCatalog: async () => readCatalog(connection, options),
    run,
    close: async () => database.close(),
  };
}

/**
 * Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind.
 * Rejects with a `SchemaError` when Postgres rejects the SQL.
 */
export async function loadCatalog(
  schemaSql: string,
  options: CatalogOptions = {},
): Promise<Catalog> {
  const schema = await openSchema(schemaSql, options);
  await schema.close();
  return schema.catalog;
}
