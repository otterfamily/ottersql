import { loadCatalog, openSchema } from "../catalog/index.ts";
import type { Catalog } from "../catalog/index.ts";
import { migratedObjects } from "./ledger.ts";
import { readMigration } from "./migration-file.ts";
import { planMigration } from "./plan-migration.ts";
import type { Plan } from "./plan.ts";

/** A file of `migrations/`, named `YYYYMMDDHHMMSS_<name>.sql` so that names sort in time order. */
export interface MigrationFile {
  readonly name: string;
  readonly text: string;
}

/** The files in the order they apply. */
export function inOrder(files: readonly MigrationFile[]): MigrationFile[] {
  return files.toSorted((left, right) => (left.name < right.name ? -1 : 1));
}

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
