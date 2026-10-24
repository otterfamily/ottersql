import { readCapabilities } from "./capabilities.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import { freshDatabase } from "./fresh-database.ts";
import type { Catalog } from "./model.ts";
import { readRoutines } from "./routines.ts";
import { schemaError } from "./schema-error.ts";
import { readTables } from "./tables.ts";
import { readViews } from "./views.ts";

/**
 * Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind.
 * Rejects with a `SchemaError` when Postgres rejects the SQL.
 */
export async function loadCatalog(schemaSql: string): Promise<Catalog> {
  const db = await freshDatabase();
  try {
    await db.exec(schemaSql).catch((error: unknown) => {
      throw schemaError(error, schemaSql) ?? error;
    });
    return {
      capabilities: await readCapabilities(db),
      tables: await readTables(db),
      enums: await readEnums(db),
      domains: await readDomains(db),
      views: await readViews(db),
      routines: await readRoutines(db),
    };
  } finally {
    await db.close();
  }
}
