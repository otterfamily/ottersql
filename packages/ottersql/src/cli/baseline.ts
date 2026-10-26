import {
  baselineMigrations,
  nextMigrationName,
  planBaseline,
  readMigrationFile,
  renderMigration,
} from "../migrate/index.ts";
import type { MigrationFile, Plan } from "../migrate/index.ts";
import type { Connection } from "../sql/index.ts";
import { planLines, planResult } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import { CommandError } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";
import { historyRefusal, locate, readMigrations, writeMigration } from "./project.ts";
import type { Layout } from "./project.ts";

type Baseline = Extract<Command, { name: "migrate baseline" }>;

/**
 * Starts the migrations of a project from an existing database: writes the steps that build it as
 * the first migration, unless there are migrations already, and records them as applied, running
 * none, once replaying them builds exactly the database.
 */
export async function baseline(context: Context, command: Baseline): Promise<Outcome> {
  const layout = await locate(context.cwd, command.project);
  const existing = await readMigrations(layout);
  if (existing.length > 0 && command.migration !== null) {
    throw new CommandError({
      kind: "invalid",
      code: "usage.invalid",
      why: "There are migrations already, so the baseline records them instead of writing one",
      fix: "Run `ottersql migrate baseline` without a name",
    });
  }
  try {
    return await withSession(context.env, async (connection) => {
      const written =
        existing.length === 0 ? await writeFirst(connection, layout, { context, command }) : null;
      const files = written === null ? existing : [written.file];
      const difference = await baselineMigrations(connection, files);
      return reported(written?.path ?? null, files, difference);
    });
  } catch (error) {
    throw historyRefusal(error, layout);
  }
}

async function writeFirst(
  connection: Connection,
  layout: Layout,
  { context, command }: { readonly context: Context; readonly command: Baseline },
): Promise<{ readonly file: MigrationFile; readonly path: string }> {
  if (command.migration === null) {
    throw new CommandError({
      kind: "invalid",
      code: "usage.invalid",
      why: "There are no migrations yet, so the baseline needs a name, such as `baseline`",
      fix: "Run `ottersql migrate baseline <name>`",
    });
  }
  const name = nextMigrationName([], command.migration, context.now);
  const text = renderMigration(await planBaseline(connection));
  return { file: { name, text }, path: await writeMigration(layout, name, text) };
}

function countSteps(files: readonly MigrationFile[]): number {
  return files.reduce((total, file) => total + readMigrationFile(file.text).length, 0);
}

function reported(
  path: string | null,
  files: readonly MigrationFile[],
  difference: Plan | null,
): Outcome {
  if (difference === null) {
    const recorded = countSteps(files);
    return {
      ok: true,
      result: { file: path, recorded },
      lines: [
        ...(path === null ? [] : [`Wrote ${path}`]),
        `Recorded ${String(recorded)} steps as applied, running none`,
      ],
    };
  }
  return {
    ok: false,
    kind: "finding",
    code: "migrate.baseline_mismatch",
    why: `The migrations do not build the database yet: ${String(difference.steps.length)} steps and ${String(difference.manual.length)} changes left to a person are missing, so nothing was recorded`,
    fix: "Write what is missing as steps in the migration (kind=custom for functions and views), then run `ottersql migrate baseline` again",
    result: { file: path, difference: planResult(difference) },
    lines: planLines(difference),
  };
}
