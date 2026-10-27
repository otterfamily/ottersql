import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { SchemaError } from "../catalog/index.ts";
import { defaultSchemaPath, migrationsDirectory } from "../content-mapper/project-layout.ts";
import {
  LockWaitTimeoutError,
  MigrationFileError,
  MigrationHistoryError,
  SessionChangedError,
} from "../migrate/index.ts";
import type { MigrationFile } from "../migrate/index.ts";
import type { Project } from "./command.ts";
import { CommandError } from "./outcome.ts";
import { CONTENT_MAPPER, readTsconfig } from "./tsconfig.ts";

/** Where a project keeps its schema and migrations, as absolute paths. */
export interface Layout {
  readonly cwd: string;
  /** The tsconfig's directory, under which `types` looks for query files. */
  readonly projectDirectory: string;
  readonly schemaFile: string;
  readonly migrationsDirectory: string;
  /** What the tsconfig leaves out of the project: its exclude patterns and its outDir. */
  readonly excluded: { readonly patterns: readonly string[]; readonly outDir: string | null };
}

const TSCONFIG = "tsconfig.json";

/**
 * Finds schema.sql where the tsconfig's ottersql content mapper looks for it, following extends as
 * TypeScript does, so editor types and migrations read the same file, and the migrations where
 * the content mapper leaves them untyped.
 */
export async function locate(cwd: string, project: Project): Promise<Layout> {
  const file = resolve(cwd, project ?? TSCONFIG);
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  const tsconfig =
    exists || project !== null
      ? await readTsconfig(file, cwd)
      : { schema: null, exclude: null, outDir: null };
  const schemaFile = tsconfig.schema ?? resolve(dirname(file), defaultSchemaPath);
  return {
    cwd,
    projectDirectory: dirname(file),
    schemaFile,
    migrationsDirectory: migrationsDirectory(schemaFile),
    excluded: { patterns: tsconfig.exclude ?? [], outDir: tsconfig.outDir },
  };
}

/** `path` as output shows it: relative to where the command runs, never absolute. */
export function shown(layout: Layout, path: string): string {
  return relative(layout.cwd, path);
}

export async function readSchema(layout: Layout): Promise<string> {
  const text = await readFile(layout.schemaFile, "utf8").catch(() => null);
  if (text === null) {
    throw new CommandError({
      kind: "invalid",
      code: "schema.unreadable",
      why: `Cannot read ${shown(layout, layout.schemaFile)}`,
      fix: `Create it, or name it in the "schema" option of the ${CONTENT_MAPPER} content mapper in tsconfig.json`,
      where: { file: shown(layout, layout.schemaFile) },
    });
  }
  return text;
}

/** The migration files in name order; they are parsed by whatever reads their steps. */
export async function readMigrations(layout: Layout): Promise<MigrationFile[]> {
  const entries = await readdir(layout.migrationsDirectory).catch(() => []);
  const names = entries.filter((name) => name.endsWith(".sql")).toSorted();
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(join(layout.migrationsDirectory, name), "utf8"),
    })),
  );
}

export async function writeMigration(layout: Layout, name: string, text: string): Promise<string> {
  await mkdir(layout.migrationsDirectory, { recursive: true });
  const path = join(layout.migrationsDirectory, name);
  await writeFile(path, text, { flag: "wx" });
  return shown(layout, path);
}

/** The refusal for schema.sql that Postgres rejected; anything else is returned as it was. */
export function schemaRefusal(layout: Layout, error: unknown): unknown {
  if (!(error instanceof SchemaError)) {
    return error;
  }
  const file = shown(layout, layout.schemaFile);
  return new CommandError({
    kind: "invalid",
    code: "schema.invalid",
    why: `Postgres rejected ${file}: ${error.message} (SQLSTATE ${error.code})`,
    fix: "Fix schema.sql",
    where: error.position === null ? { file } : { file, line: error.position.line },
  });
}

/** The refusal for a migration file that cannot be read, pointing at the file and line. */
export function unreadableMigration(
  layout: Layout,
  error: Pick<MigrationFileError, "message" | "file" | "line">,
): CommandError {
  return new CommandError({
    kind: "invalid",
    code: "migrate.file_invalid",
    why: error.message,
    fix: "Fix the migration file; each step's SQL follows a `-- ottersql:step` line",
    where: {
      file: shown(layout, join(layout.migrationsDirectory, error.file ?? "")),
      ...(error.line === null ? {} : { line: error.line }),
    },
  });
}

/**
 * The refusal for what running the migrations against a database threw: a file that cannot be
 * read, a history that disagrees with the files, a lock another run kept too long, or a connection
 * that changed session; anything else is returned as it was.
 */
export function migrationRefusal(layout: Layout, error: unknown): unknown {
  if (error instanceof MigrationFileError) {
    return unreadableMigration(layout, error);
  }
  if (error instanceof MigrationHistoryError) {
    return new CommandError({
      kind: "invalid",
      code: "migrate.history_mismatch",
      why: error.message,
      fix: "Leave applied migrations as they are, and put new changes in a new migration",
    });
  }
  if (error instanceof LockWaitTimeoutError) {
    return new CommandError({
      kind: "failed",
      code: "migrate.lock_busy",
      why: error.message,
      fix:
        error.holder === null
          ? "Run again; the other run has just finished"
          : `Wait for the other run to finish, or, if it is stuck, end its session with \`select pg_terminate_backend(${String(error.holder)})\``,
      result: { holder: error.holder },
    });
  }
  if (error instanceof SessionChangedError) {
    return new CommandError({
      kind: "failed",
      code: "database.session_changed",
      why: error.message,
      fix: "Connect to Postgres directly or through a pooler in session mode, not one in transaction mode; until the first session ends, other runs wait for its lock",
      result: { finished: error.finished },
    });
  }
  return error;
}
