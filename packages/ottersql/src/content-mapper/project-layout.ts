import { dirname, join } from "node:path";

// Apart from the content mapper, which loads PGlite: the CLI reads these where PGlite may be absent.

/** Where a project keeps its schema when its tsconfig gives no `schema` option, relative to the tsconfig. */
export const defaultSchemaPath = "db/schema.sql";

/** Where a project keeps its migrations: the `migrations` directory next to its schema (#27). */
export function migrationsDirectory(schemaPath: string): string {
  return join(dirname(schemaPath), "migrations");
}
