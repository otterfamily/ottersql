import type { Connection } from "../sql/index.ts";
import { readCapabilities } from "./capabilities.ts";
import { readFeatures } from "./features.ts";
import type { Catalog } from "./model.ts";
import { readSchemaObjects } from "./schema-objects.ts";
import { readSchemas } from "./schemas.ts";
import { readTables } from "./tables.ts";

/** What the catalog reads: the objects of every user schema but those it is told to leave out. */
export interface CatalogOptions {
  /** Schemas whose objects are left out, such as a tool's own record of what it did. */
  readonly omitSchemas?: readonly string[];
}

/**
 * Reads the catalog of the database `connection` reaches: PGlite running a schema.sql, or a real
 * database through its driver. Throws a `CatalogShapeError` naming the field when the catalog does
 * not have the shape ottersql reads.
 */
export async function readCatalog(
  connection: Connection,
  { omitSchemas = [] }: CatalogOptions = {},
): Promise<Catalog> {
  // Postgres prints a type or a name in an expression without its schema when the search_path
  // finds it, so the session's search_path, which schema.sql may set, would decide what migrations
  // say; with public alone, everything outside public is named with its schema. Repeatable read
  // gives every query the same snapshot, so a change made meanwhile cannot show half-way.
  return connection.transaction(
    async (transaction) => {
      const features = await readFeatures(transaction);
      return {
        capabilities: await readCapabilities(transaction),
        schemas: await readSchemas(transaction, omitSchemas),
        tables: await readTables(transaction, features, omitSchemas),
        ...(await readSchemaObjects(transaction, features, omitSchemas)),
      };
    },
    { isolation: "repeatable read", readOnly: true, settings: { search_path: "public" } },
  );
}
