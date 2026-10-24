import type { PGlite } from "@electric-sql/pglite";

import { readCapabilities } from "./capabilities.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import type { Catalog } from "./model.ts";
import { readRanges } from "./ranges.ts";
import { readRoutines } from "./routines.ts";
import { readTables } from "./tables.ts";
import { readViews } from "./views.ts";

export async function readCatalog(db: PGlite): Promise<Catalog> {
  return {
    capabilities: await readCapabilities(db),
    tables: await readTables(db),
    enums: await readEnums(db),
    ranges: await readRanges(db),
    domains: await readDomains(db),
    views: await readViews(db),
    routines: await readRoutines(db),
  };
}
