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
  // Postgres prints a type or a name in an expression without its schema when the search_path
  // finds it, so the session's search_path, which schema.sql may set, would decide what migrations
  // say; with public alone, everything outside public is named with its schema. Repeatable read
  // gives every query the same snapshot, so a change made meanwhile cannot show half-way.
  return connection.transaction(
    async (transaction) => {
      const features = await readFeatures(transaction);
      return {
        capabilities: await readCapabilities(transaction),
        tables: await readTables(transaction, features),
        enums: await readEnums(transaction),
        ranges: await readRanges(transaction),
        domains: await readDomains(transaction, features),
        views: await readViews(transaction),
        routines: await readRoutines(transaction),
      };
    },
    { isolation: "repeatable read", readOnly: true, settings: { search_path: "public" } },
  );
}
