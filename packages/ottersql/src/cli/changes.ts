import { MigrationFileError, pendingChanges } from "../migrate/index.ts";
import type { ManualChange, MigrationFile, Plan } from "../migrate/index.ts";
import { readSchema, schemaRefusal, unreadableMigration } from "./project.ts";
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

/** The plan as people read it, a line for each step and each change left to them. */
export function planLines(plan: Plan): string[] {
  return [
    ...plan.steps.map(
      ({ kind, object, phase, reversal, transaction, lock }) =>
        `  ${phase} ${kind} ${object} (${reversal}, ${transaction}, lock ${lock})`,
    ),
    ...manualLines(plan.manual),
  ];
}

/** The changes left to a person as people read them, a line for each. */
export function manualLines(manual: readonly ManualChange[]): string[] {
  return manual.map(({ object, reason }) => `  by hand: ${object}: ${reason}`);
}
