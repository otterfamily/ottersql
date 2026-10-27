import { dirname, join } from "node:path";

import { holdsQueries } from "../sql/internal.ts";

// Apart from the content mapper, which loads PGlite: the CLI reads these where PGlite may be absent.

/** Where a project keeps its schema when its tsconfig gives no `schema` option, relative to the tsconfig. */
export const defaultSchemaPath = "db/schema.sql";

/** Where a project keeps its migrations: the `migrations` directory next to its schema (#27). */
export function migrationsDirectory(schemaPath: string): string {
  return join(dirname(schemaPath), "migrations");
}

/**
 * Whether `file` holds queries to type: not the schema, not a migration, and with `-- @name`
 * queries, unlike the `.sql` files other tools keep next to it. Both the content mapper and
 * `ottersql types` go by it.
 */
export function isQueryFile(schemaPath: string, file: string, content: string): boolean {
  return (
    file !== schemaPath &&
    dirname(file) !== migrationsDirectory(schemaPath) &&
    holdsQueries(content)
  );
}
