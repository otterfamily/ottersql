import { migrationStatus } from "../migrate/index.ts";
import type { MigrationStatus } from "../migrate/index.ts";
import { planLines } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import type { Outcome } from "./outcome.ts";
import { migrationRefusal, locate, readMigrations } from "./project.ts";
import { planJson, stepStatusJson } from "./results.ts";

/** Lists which migration steps ran on DATABASE_URL, and what was changed there by hand. */
export async function status(
  context: Context,
  command: Extract<Command, { name: "migrate status" }>,
): Promise<Outcome> {
  const layout = await locate(context.cwd, command.project);
  const files = await readMigrations(layout);
  try {
    return reported(
      await withSession(context.env, async (connection) => migrationStatus(connection, files)),
    );
  } catch (error) {
    throw migrationRefusal(error, layout);
  }
}

function reported({ steps, drift }: MigrationStatus): Outcome {
  const applied = steps.filter((step) => step.applied).length;
  const lines = steps.map(
    ({ migration, step, kind, object, phase, applied: ran }) =>
      `  ${ran ? "applied" : "pending"}  ${migration} step ${String(step)}: ${phase} ${kind} ${object}`,
  );
  if (drift === null) {
    return {
      ok: true,
      result: { steps: steps.map((step) => stepStatusJson(step)), drift: null },
      lines: [
        `${String(applied)} of ${String(steps.length)} steps applied; the database matches them`,
        ...lines,
      ],
    };
  }
  return {
    ok: false,
    kind: "finding",
    code: "migrate.drift",
    why: `The database differs from what its applied migrations build: ${String(drift.steps.length)} steps and ${String(drift.manual.length)} changes left to a person would turn one into the other`,
    fix: "Find out who changed the database outside the migrations; put the change in a migration, or undo it in the database",
    result: { steps: steps.map((step) => stepStatusJson(step)), drift: planJson(drift) },
    lines: [...lines, "Differences:", ...planLines(drift)],
  };
}
