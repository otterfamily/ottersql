import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import { freshDatabase } from "./fresh-database.ts";
import type { Catalog } from "./model.ts";
import { readTables } from "./tables.ts";
import { readViews } from "./views.ts";

/** Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind. */
export async function loadCatalog(schemaSql: string): Promise<Catalog> {
  const db = await freshDatabase();
  try {
    await db.exec(schemaSql);
    return {
      tables: await readTables(db),
      enums: await readEnums(db),
      domains: await readDomains(db),
      views: await readViews(db),
    };
  } finally {
    await db.close();
  }
}
