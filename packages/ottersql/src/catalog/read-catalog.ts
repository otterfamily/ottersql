import type { Connection } from "../sql/index.ts";
import { readCapabilities } from "./capabilities.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import { readFeatures } from "./features.ts";
import type { Catalog } from "./model.ts";
import { readRanges } from "./ranges.ts";
import { readRoutines } from "./routines.ts";
import { readTables } from "./tables.ts";
import { readViews } from "./views.ts";

/**
 * Reads the catalog of the database `connection` reaches: PGlite running a schema.sql, or a real
 * database through its driver. Throws a `CatalogShapeError` naming the field when the catalog does
 * not have the shape ottersql reads.
 */
export async function readCatalog(connection: Connection): Promise<Catalog> {
  const features = await readFeatures(connection);
  return {
    capabilities: await readCapabilities(connection),
    tables: await readTables(connection, features),
    enums: await readEnums(connection),
    ranges: await readRanges(connection),
    domains: await readDomains(connection, features),
    views: await readViews(connection),
    routines: await readRoutines(connection),
  };
}
