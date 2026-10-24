import { renderMigration } from "@ottersql/migrate";

import { changesToSchema, isEmpty, planLines, planResult } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import type { Outcome } from "./outcome.ts";
import { locate, readMigrations, shown, writeMigration } from "./project.ts";
import { nextStamp } from "./stamp.ts";

/** Writes what schema.sql adds to the migrations as the next migration file. */
export async function generate(
  context: Context,
  command: Extract<Command, { name: "migrate generate" }>,
): Promise<Outcome> {
  const layout = await locate(context.cwd, command.project);
  const files = await readMigrations(layout);
  const plan = await changesToSchema(layout, files);
  if (isEmpty(plan)) {
    return {
      ok: true,
      result: { file: null, ...planResult(plan) },
      lines: [`The migrations already build ${shown(layout, layout.schemaFile)}`],
    };
  }
  const name = `${nextStamp(
    files.map((file) => file.name),
    context.now,
  )}_${command.migration}.sql`;
  const file = await writeMigration(layout, name, renderMigration(plan));
  return {
    ok: true,
    result: { file, ...planResult(plan) },
    lines: [`Wrote ${file} with ${String(plan.steps.length)} steps:`, ...planLines(plan)],
  };
}
