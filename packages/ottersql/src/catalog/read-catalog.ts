import type { Connection } from "../sql/index.ts";
import { capabilitiesRead } from "./capabilities.ts";
import { queryCatalog, queryOne } from "./catalog-json.ts";
import { featuresRead } from "./features.ts";
import type { Catalog } from "./model/catalog.ts";
import { schemaObjectReads } from "./schema-objects.ts";
import { schemasRead } from "./schemas.ts";
import { scopeParameters } from "./scope.ts";
import { tablesRead } from "./tables.ts";

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
  // gives every query the same snapshot, so a change made meanwhile cannot show half-way. JIT
  // compilation is off because the planner can estimate a catalog statement costly enough for it,
  // and compiling it then takes many times longer than running it.
  return connection.transaction(
    async (transaction) => {
      // The other queries are written from the features, so they cannot share their statement.
      const features = await queryOne(transaction, featuresRead);
      const tables = tablesRead(features);
      const objects = schemaObjectReads(features);
      const results = await queryCatalog(
        transaction,
        [capabilitiesRead, schemasRead, tables, ...objects.reads],
        scopeParameters(omitSchemas),
      );
      return {
        capabilities: results(capabilitiesRead),
        schemas: results(schemasRead),
        tables: results(tables),
        ...objects.make(results),
      };
    },
    {
      isolation: "repeatable read",
      readOnly: true,
      settings: { search_path: "public", jit: "off" },
    },
  );
}
