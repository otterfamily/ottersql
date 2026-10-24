import { PGlite } from "@electric-sql/pglite";

import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import type { Catalog } from "./model.ts";
import { readTables } from "./tables.ts";

/** Runs `schemaSql` in a throwaway in-process Postgres and reads the catalog it leaves behind. */
export async function loadCatalog(schemaSql: string): Promise<Catalog> {
  const db = await PGlite.create();
  try {
    await db.exec(schemaSql);
    return {
      tables: await readTables(db),
      enums: await readEnums(db),
      domains: await readDomains(db),
    };
  } finally {
    await db.close();
  }
}
