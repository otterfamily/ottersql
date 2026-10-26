import { SchemaError } from "../catalog/index.ts";
import { MigrationFileError, pendingChanges } from "../migrate/index.ts";
import type { MigrationFile, Plan } from "../migrate/index.ts";
import { CommandError } from "./outcome.ts";
import { readSchema, shown, unreadableMigration } from "./project.ts";
import type { Layout } from "./project.ts";

/** What schema.sql adds to the schema `files` build. */
export async function changesToSchema(
  layout: Layout,
  files: readonly MigrationFile[],
): Promise<Plan> {
  const schema = await readSchema(layout);
  try {
    return await pendingChanges(files, schema);
  } catch (error) {
    throw error instanceof MigrationFileError
      ? unreadableMigration(layout, error)
      : schemaRefusal(layout, error);
  }
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

export function isEmpty(plan: Plan): boolean {
  return plan.steps.length === 0 && plan.manual.length === 0;
}

/** The plan as people read it, a line for each step and each change left to them. */
export function planLines(plan: Plan): string[] {
  return [
    ...plan.steps.map(
      ({ kind, object, phase, reversal, transaction, lock }) =>
        `  ${phase} ${kind} ${object} (${reversal}, ${transaction}, lock ${lock})`,
    ),
    ...plan.manual.map(({ object, reason }) => `  by hand: ${object}: ${reason}`),
  ];
}
