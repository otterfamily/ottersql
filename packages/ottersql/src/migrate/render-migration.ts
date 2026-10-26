import { PREFIX } from "./migration-file.ts";
import type { Plan, Step } from "./plan.ts";

/**
 * A migration file for `plan`: each step's SQL under a `-- ottersql:step` line that carries what
 * the applier and a reviewer need, so the file stays plain SQL. Changes left to a person are listed
 * as comments, for them to write as steps.
 */
export function renderMigration(plan: Plan): string {
  const manual = plan.manual.map(
    ({ object, reason }) => `-- ${PREFIX}manual ${object}\n-- ${reason}\n`,
  );
  const steps = plan.steps.map((step) =>
    [
      `-- ${PREFIX}step ${stepHeader(step)}`,
      ...(step.reason === null ? [] : [`-- ${step.reason}`]),
      ...(step.transaction === "outside" && step.cleanup !== null
        ? [
            `-- ${PREFIX}cleanup schema=${JSON.stringify(step.cleanup.schema)} index=${JSON.stringify(step.cleanup.name)}`,
          ]
        : []),
      ...step.statements.map((sql) => `${sql};`),
      "",
    ].join("\n"),
  );
  return [...manual, ...steps].join("\n");
}

/**
 * A migration file with no steps yet, for a person to write them: data to move, or objects
 * ottersql does not plan. It explains the step line, which on its own is a plain comment here.
 */
export function emptyMigration(): string {
  return [
    "-- Steps written by hand. Each starts with a line such as",
    `-- -- ${PREFIX}step kind=custom object="public.users"`,
    "-- followed by its SQL. A step that leaves out phase, reversal, transaction or lock runs after",
    "-- the deploy, in a transaction, and waits for approval: say what it does, such as",
    `-- -- ${PREFIX}step kind=custom object="public.users" phase=contract reversal=lossy lock="row exclusive"`,
    "-- for an UPDATE that fills a column. Whatever the steps create must be in schema.sql too.",
    "",
  ].join("\n");
}

function stepHeader(step: Step): string {
  return [
    `kind=${step.kind}`,
    `object=${JSON.stringify(step.object)}`,
    `phase=${step.phase}`,
    `reversal=${step.reversal}`,
    `transaction=${step.transaction}`,
    `lock=${JSON.stringify(step.lock)}`,
  ].join(" ");
}
