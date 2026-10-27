import { readFile, rm, writeFile } from "node:fs/promises";

import { declarationFiles, isGeneratedDeclarationFile } from "../../content-mapper/index.ts";
import type { DeclarationFile, DeclarationFileProblem } from "../../content-mapper/index.ts";
import type { Command } from "../command.ts";
import type { Context } from "../context.ts";
import { CommandError } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { locate, readSchema, schemaRefusal, shown } from "../project.ts";
import type { Layout } from "../project.ts";
import { orphanedDeclarationFiles, queryFiles } from "../query-files.ts";
import { problemJson } from "../results.ts";

/** What `types` changes, or would change with `--check`, as paths relative to the working directory. */
interface Changes {
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly problems: readonly DeclarationFileProblem[];
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
    orphaned: await orphanedDeclarationFiles(layout, queries),
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

/** The changes as JSON shows them. */
function changesJson(changes: Changes): object {
  return {
    written: changes.written,
    removed: changes.removed,
    problems: changes.problems.map((problem) => problemJson(problem)),
  };
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
    result: changesJson(result),
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
    return { ok: true, result: changesJson(result), lines };
  }
  return {
    ok: false,
    kind: "finding",
    code: "types.query_invalid",
    why: `${String(result.problems.length)} queries cannot be typed; their files' other queries are declared`,
    fix: "Fix the queries listed",
    where: { file: problem.file, line: problem.line },
    result: changesJson(result),
    lines: [...lines, ...problemLines(result.problems)],
  };
}

/**
 * Writes the declarations of each query file next to it, the same ones the content mapper serves,
 * for tools that cannot run content mappers. With `--check`, only reports what it would change.
 */
export async function run(
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
