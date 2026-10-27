import { loadCatalog, openSchema } from "../catalog/index.ts";
import type { Catalog } from "../catalog/index.ts";
import { migratedObjects } from "./ledger.ts";
import { inOrder, readMigration } from "./migration-file.ts";
import type { MigrationFile } from "./migration-file.ts";
import { planMigration } from "./plan-migration.ts";
import type { Plan } from "./plan.ts";

/** The schema `files` build when run in order on an empty database, replayed in PGlite. */
async function replayedCatalog(files: readonly MigrationFile[]): Promise<Catalog> {
  return replay(
    inOrder(files).flatMap((file) => readMigration(file).flatMap(({ statements }) => statements)),
  );
}

/** The schema `statements` build when run in order on an empty database, in PGlite. */
export async function replay(statements: readonly string[]): Promise<Catalog> {
  const schema = await openSchema("", { alsoRuns: statements, ...migratedObjects });
  try {
    for (const sql of statements) {
      await schema.run(sql);
    }
    return await schema.readCatalog();
  } finally {
    await schema.close();
  }
}

/**
 * What `schemaSql` adds to the schema `files` build: the next migration to write, or, when it is
 * empty, the proof that the migrations and `schema.sql` agree.
 */
export async function pendingChanges(
  files: readonly MigrationFile[],
  schemaSql: string,
): Promise<Plan> {
  return planMigration(await replayedCatalog(files), await loadCatalog(schemaSql, migratedObjects));
}
