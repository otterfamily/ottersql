import { PGlite } from "@electric-sql/pglite";
import type { Catalog } from "./model.ts";
import { readTables } from "./tables.ts";

/** Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind. */
export async function loadCatalog(schemaSql: string): Promise<Catalog> {
  const db = await PGlite.create();
  try {
    await db.exec(schemaSql);
    return { tables: await readTables(db) };
  } finally {
    await db.close();
  }
}
