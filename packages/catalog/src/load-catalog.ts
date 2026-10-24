import type { PGlite } from "@electric-sql/pglite";

import { readCapabilities } from "./capabilities.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import { freshDatabase } from "./fresh-database.ts";
import type { Catalog } from "./model.ts";
import { readRoutines } from "./routines.ts";
import { schemaError } from "./schema-error.ts";
import { readTables } from "./tables.ts";
import { readViews } from "./views.ts";

/** A throwaway in-process Postgres with a schema applied, and the catalog read from it. */
export interface OpenSchema {
  readonly catalog: Catalog;
  /** Queries run here see the schema; the database is discarded on `close`. */
  readonly database: PGlite;
  readonly close: () => Promise<void>;
}

/**
 * Runs `schemaSql` in a throwaway in-process Postgres, reads its catalog and keeps the database
 * open for further queries. Rejects with a `SchemaError` when Postgres rejects the SQL.
 */
export async function openSchema(schemaSql: string): Promise<OpenSchema> {
  const database = await freshDatabase();
  try {
    await database.exec(schemaSql).catch((error: unknown) => {
      throw schemaError(error, schemaSql) ?? error;
    });
    const catalog = await readCatalog(database);
    return { catalog, database, close: async () => database.close() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

/**
 * Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind.
 * Rejects with a `SchemaError` when Postgres rejects the SQL.
 */
export async function loadCatalog(schemaSql: string): Promise<Catalog> {
  const schema = await openSchema(schemaSql);
  await schema.close();
  return schema.catalog;
}

async function readCatalog(db: PGlite): Promise<Catalog> {
  return {
    capabilities: await readCapabilities(db),
    tables: await readTables(db),
    enums: await readEnums(db),
    domains: await readDomains(db),
    views: await readViews(db),
    routines: await readRoutines(db),
  };
}
