import { glob, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  declarationFileName,
  declarationFiles,
  isGeneratedDeclarationFile,
} from "../content-mapper/index.ts";
import type { DeclarationFile, DeclarationFileProblem } from "../content-mapper/index.ts";
import { schemaRefusal } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { CommandError } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";
import { locate, readSchema, shown } from "./project.ts";
import type { Layout } from "./project.ts";

/** What `types` changes, or would change with `--check`, as paths relative to the working directory. */
interface Changes {
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly problems: readonly DeclarationFileProblem[];
}

/** Directories that hold no query files of the project. */
function skipped(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/** The project's query files: every `.sql` file but schema.sql and the migrations. */
async function queryFiles(layout: Layout): Promise<string[]> {
  const found: string[] = [];
  for await (const path of glob("**/*.sql", {
    cwd: layout.projectDirectory,
    exclude: (name) => skipped(basename(name)),
  })) {
    const file = join(layout.projectDirectory, path);
    if (file !== layout.schemaFile && dirname(file) !== layout.migrationsDirectory) {
      found.push(file);
    }
  }
  return found.toSorted();
}

async function render(layout: Layout, files: readonly string[]): Promise<DeclarationFile[]> {
  const schema = await readSchema(layout);
  const contents = await Promise.all(
    files.map(async (path) => ({ path, content: await readFile(path, "utf8") })),
  );
  try {
    return await declarationFiles(schema, contents);
  } catch (error) {
    throw schemaRefusal(layout, error);
  }
}

/** Whether `file` must be written; refuses to replace a declaration file a person wrote. */
async function isOutOfDate(layout: Layout, file: DeclarationFile): Promise<boolean> {
  const existing = await readFile(file.path, "utf8").catch(() => null);
  if (existing !== null && !isGeneratedDeclarationFile(existing)) {
    throw new CommandError({
      kind: "invalid",
      code: "types.not_generated",
      why: `${shown(layout, file.path)} was not written by ottersql, so it is left as it is`,
      fix: "Rename or remove it, so ottersql can write the declarations of its query file there",
      where: { file: shown(layout, file.path) },
    });
  }
  return existing !== file.text;
}

/** Declaration files ottersql wrote whose query file is gone. */
async function orphans(layout: Layout, queries: readonly string[]): Promise<string[]> {
  const expected = new Set(queries.map((query) => declarationFileName(query)));
  const found: string[] = [];
  for await (const path of glob("**/*.d.sql.ts", {
    cwd: layout.projectDirectory,
    exclude: (name) => skipped(basename(name)),
  })) {
    const file = join(layout.projectDirectory, path);
    if (!expected.has(file) && isGeneratedDeclarationFile(await readFile(file, "utf8"))) {
      found.push(file);
    }
  }
  return found.toSorted();
}

async function changesOf(layout: Layout): Promise<{
  readonly stale: readonly DeclarationFile[];
  readonly orphaned: readonly string[];
  readonly problems: readonly DeclarationFileProblem[];
}> {
  const queries = await queryFiles(layout);
  const rendered = await render(layout, queries);
  const outOfDate = await Promise.all(rendered.map(async (file) => isOutOfDate(layout, file)));
  return {
    stale: rendered.filter((_file, index) => outOfDate[index] === true),
    orphaned: await orphans(layout, queries),
    problems: rendered.flatMap((file) => file.problems),
  };
}

function shownChanges(layout: Layout, changes: Awaited<ReturnType<typeof changesOf>>): Changes {
  return {
    written: changes.stale.map((file) => shown(layout, file.path)),
    removed: changes.orphaned.map((file) => shown(layout, file)),
    problems: changes.problems.map((problem) => ({
      ...problem,
      file: shown(layout, problem.file),
    })),
  };
}

function problemLines(problems: readonly DeclarationFileProblem[]): string[] {
  return problems.map(
    ({ file, line, column, message }) => `  ${file}:${String(line)}:${String(column)} ${message}`,
  );
}

function checked(result: Changes): Outcome {
  const files = [...result.written, ...result.removed];
  if (files.length === 0) {
    return withProblems(result, ["The declaration files are up to date"]);
  }
  return {
    ok: false,
    kind: "finding",
    code: "types.out_of_date",
    why: `${String(files.length)} declaration files are missing, out of date or left over`,
    fix: "Run `ottersql types` and commit the files it writes",
    result,
    lines: [
      ...result.written.map((file) => `  write ${file}`),
      ...result.removed.map((file) => `  remove ${file}`),
    ],
  };
}

function written(result: Changes): Outcome {
  const lines = [
    `Wrote ${String(result.written.length)} and removed ${String(result.removed.length)} declaration files`,
    ...result.written.map((file) => `  wrote ${file}`),
    ...result.removed.map((file) => `  removed ${file}`),
  ];
  return withProblems(result, lines);
}

/** Success with `lines`, unless a query in the files cannot be typed. */
function withProblems(result: Changes, lines: readonly string[]): Outcome {
  const [problem] = result.problems;
  if (problem === undefined) {
    return { ok: true, result, lines };
  }
  return {
    ok: false,
    kind: "finding",
    code: "types.query_invalid",
    why: `${String(result.problems.length)} queries cannot be typed; their files' other queries are declared`,
    fix: "Fix the queries listed",
    where: { file: problem.file, line: problem.line },
    result,
    lines: [...lines, ...problemLines(result.problems)],
  };
}

/**
 * Writes the declarations of each query file next to it, the same ones the content mapper serves,
 * for tools that cannot run content mappers. With `--check`, only reports what it would change.
 */
export async function types(
  context: Context,
  command: Extract<Command, { name: "types" }>,
): Promise<Outcome> {
  const layout = await locate(context.cwd, command.project);
  const changes = await changesOf(layout);
  const result = shownChanges(layout, changes);
  if (command.check) {
    return checked(result);
  }
  for (const file of changes.stale) {
    await writeFile(file.path, file.text);
  }
  for (const file of changes.orphaned) {
    await rm(file);
  }
  return written(result);
}
