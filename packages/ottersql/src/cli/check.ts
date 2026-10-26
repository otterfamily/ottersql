import { changesToSchema, isEmpty, planLines, planResult } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import type { Outcome } from "./outcome.ts";
import { locate, readMigrations, shown } from "./project.ts";

/** Checks that the migrations, replayed in PGlite, build exactly what schema.sql describes. */
export async function check(
  context: Context,
  command: Extract<Command, { name: "migrate check" }>,
): Promise<Outcome> {
  const layout = await locate(context.cwd, command.project);
  const plan = await changesToSchema(layout, await readMigrations(layout));
  const schema = shown(layout, layout.schemaFile);
  if (isEmpty(plan)) {
    return { ok: true, result: {}, lines: [`The migrations build ${schema}`] };
  }
  return {
    ok: false,
    kind: "finding",
    code: "migrate.out_of_date",
    why: `The migrations do not build ${schema}: ${String(plan.steps.length)} steps and ${String(plan.manual.length)} changes left to a person are missing`,
    fix: "Run `ottersql migrate generate <name>` and review the migration it writes",
    result: planResult(plan),
    lines: planLines(plan),
  };
}
