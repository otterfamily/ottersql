import { ApprovalRequiredError, MigrationHistoryError, pushSchema } from "../migrate/index.ts";
import type { PushResult } from "../migrate/index.ts";
import { approvalRequired, refuseApprovalByAgent } from "./approval.ts";
import type { Approvable } from "./approval.ts";
import { manualLines, schemaRefusal } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import { CommandError } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";
import { locate, readSchema } from "./project.ts";
import type { Layout } from "./project.ts";
import { failedPushJson, manualJson, plannedStepJson } from "./results.ts";

type Push = Extract<Command, { name: "push" }>;

const pushing: Approvable = { command: "ottersql push", namespace: "push" };

/**
 * Brings the database at DATABASE_URL, which must be on this machine, to schema.sql directly, for
 * trying changes out before writing them as migrations.
 */
export async function push(context: Context, command: Push): Promise<Outcome> {
  refuseApprovalByAgent(context, command.approve, pushing);
  const layout = await locate(context.cwd, command.project);
  const schema = await readSchema(layout);
  try {
    const result = await withSession(
      context.env,
      async (connection) =>
        pushSchema(
          connection,
          schema,
          command.approve === null ? {} : { approve: command.approve },
        ),
      { onlyLocal: "push" },
    );
    return reported(result);
  } catch (error) {
    throw refusal(error, layout, context.agent);
  }
}

/** The refusal `error` stands for, or `error` itself when it is not one. */
function refusal(error: unknown, layout: Layout, agent: string | null): unknown {
  if (error instanceof ApprovalRequiredError) {
    return approvalRequired(error, agent, pushing);
  }
  return error instanceof MigrationHistoryError
    ? new CommandError({
        kind: "invalid",
        code: "push.migrated_database",
        why: error.message,
        fix: "Write the change as a migration with `ottersql migrate generate`, and apply it",
      })
    : schemaRefusal(layout, error);
}

function reported({ applied, failed, manual }: PushResult): Outcome {
  const steps = applied.map((step) => plannedStepJson(step));
  if (manual.length > 0) {
    return {
      ok: false,
      kind: "finding",
      code: "push.manual",
      why: `${String(manual.length)} changes are left to a person, so nothing was pushed`,
      fix: "Make those changes in the database by hand, or write them as migrations",
      result: { manual: manual.map((change) => manualJson(change)) },
      lines: manualLines(manual),
    };
  }
  if (failed !== null) {
    return {
      ok: false,
      kind: "failed",
      code: "push.step_failed",
      why: `${failed.kind} ${failed.object} failed: ${failed.message} (SQLSTATE ${failed.code})`,
      fix: "Fix the cause, then push again",
      result: { applied: steps, failed: failedPushJson(failed) },
    };
  }
  return {
    ok: true,
    result: { applied: steps },
    lines: [
      `Pushed ${String(applied.length)} steps`,
      ...applied.map(({ phase, kind, object }) => `  ${phase} ${kind} ${object}`),
    ],
  };
}
