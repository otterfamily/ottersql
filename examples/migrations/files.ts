import { readdir, readFile } from "node:fs/promises";

import type { MigrationFile } from "@ottersql/migrate";

export const migrationsDirectory = new URL("db/migrations/", import.meta.url);
export const schemaFile = new URL("db/schema.sql", import.meta.url);

/** Where `pnpm db:up` starts Postgres, unless DATABASE_URL says otherwise. */
export const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://ottersql:ottersql@localhost:54329/example";

export async function readMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory);
  const names = entries.filter((name) => name.endsWith(".sql")).toSorted();
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(new URL(name, migrationsDirectory), "utf8"),
    })),
  );
}
