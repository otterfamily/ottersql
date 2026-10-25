import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { defaultSchemaPath } from "@ottersql/content-mapper";
import { MigrationFileError, MigrationHistoryError } from "@ottersql/migrate";
import type { MigrationFile } from "@ottersql/migrate";
import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import type { Project } from "./command.ts";
import { CommandError } from "./outcome.ts";

/** Where a project keeps its schema and migrations, as absolute paths. */
export interface Layout {
  readonly cwd: string;
  readonly schemaFile: string;
  readonly migrationsDirectory: string;
}

const CONTENT_MAPPER = "@ottersql/content-mapper";
const TSCONFIG = "tsconfig.json";

/**
 * Finds schema.sql where the tsconfig's ottersql content mapper looks for it, so editor types and
 * migrations read the same file; migrations live next to it (#27).
 */
export async function locate(cwd: string, project: Project): Promise<Layout> {
  const tsconfig = resolve(cwd, project ?? TSCONFIG);
  const text = await readFile(tsconfig, "utf8").catch(() => null);
  if (text === null && project !== null) {
    throw new CommandError({
      kind: "invalid",
      code: "project.tsconfig_unreadable",
      why: `Cannot read ${project}`,
      fix: "Pass --project the path of a tsconfig, or leave it out",
      where: { file: relative(cwd, tsconfig) },
    });
  }
  const schema = text === null ? defaultSchemaPath : schemaOption(text, relative(cwd, tsconfig));
  const schemaFile = resolve(dirname(tsconfig), schema);
  return { cwd, schemaFile, migrationsDirectory: join(dirname(schemaFile), "migrations") };
}

function schemaOption(text: string, file: string): string {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error !== undefined) {
    throw new CommandError({
      kind: "invalid",
      code: "project.tsconfig_invalid",
      why: `${file} is not valid JSON: ${printParseErrorCode(error.error)}`,
      fix: "Fix the tsconfig",
      where: { file, line: lineAt(text, error.offset) },
    });
  }
  const mappers = field(config, "contentMappers");
  const mapper = isList(mappers)
    ? mappers.find((entry) => field(entry, "package") === CONTENT_MAPPER)
    : undefined;
  const schema = field(field(mapper, "options"), "schema");
  return typeof schema === "string" ? schema : defaultSchemaPath;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
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

export async function writeMigration(layout: Layout, name: string, text: string): Promise<string> {
  await mkdir(layout.migrationsDirectory, { recursive: true });
  const path = join(layout.migrationsDirectory, name);
  await writeFile(path, text, { flag: "wx" });
  return shown(layout, path);
}

/**
 * The refusal for what reading the migrations against a database threw: a file that cannot be
 * read, or a history that disagrees with the files; anything else is returned as it was.
 */
export function historyRefusal(error: unknown, layout: Layout): unknown {
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
  return error;
}
