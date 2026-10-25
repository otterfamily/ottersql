import type { PGlite } from "@electric-sql/pglite";
import { pgliteConnection } from "@ottersql/sql/pglite";

import { extensionsFor, skippedNote, withoutMissing } from "./extensions.ts";
import { freshDatabase } from "./fresh-database.ts";
import type { Catalog } from "./model.ts";
import { readCatalog } from "./read-catalog.ts";
import { schemaError } from "./schema-error.ts";

/** A throwaway in-process Postgres with a schema applied, and the catalog read from it. */
export interface OpenSchema {
  readonly catalog: Catalog;
  /** Queries run here see the schema; the database is discarded on `close`. */
  readonly database: PGlite;
  /** Reads the catalog of `database` as it is now, after statements have changed it. */
  readonly readCatalog: () => Promise<Catalog>;
  /**
   * Runs `sql` in `database` as the schema was run: creating an extension PGlite lacks is skipped,
   * and an error says so. Its extensions must have been named in `alsoRuns` when opening.
   */
  readonly run: (sql: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Runs `schemaSql` in a throwaway in-process Postgres, reads its catalog and keeps the database
 * open for further queries. PGlite starts with the extensions that `schemaSql` and `alsoRuns`, SQL
 * to be run later, create; creating one it does not ship is skipped, which an extension that no
 * object uses, such as pgaudit, never notices. Rejects with a `SchemaError` when Postgres rejects
 * the SQL.
 */
export async function openSchema(
  schemaSql: string,
  { alsoRuns = [] }: { readonly alsoRuns?: readonly string[] } = {},
): Promise<OpenSchema> {
  const { shipped, missing } = await extensionsFor([schemaSql, ...alsoRuns]);
  const database = await freshDatabase(shipped);
  const run = async (sql: string): Promise<void> => {
    await database.exec(withoutMissing(sql, missing)).catch((error: unknown) => {
      throw schemaError(error, sql, skippedNote(missing)) ?? error;
    });
  };
  try {
    await run(schemaSql);
    const connection = pgliteConnection(database);
    const catalog = await readCatalog(connection);
    return {
      catalog,
      database,
      readCatalog: async () => readCatalog(connection),
      run,
      close: async () => database.close(),
    };
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
