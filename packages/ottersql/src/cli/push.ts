import { ApprovalRequiredError, pushSchema } from "../migrate/index.ts";
import type { PushResult } from "../migrate/index.ts";
import { approvalRequired, refuseApprovalByAgent } from "./approval.ts";
import type { Approvable } from "./approval.ts";
import { schemaRefusal } from "./changes.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import type { Outcome } from "./outcome.ts";
import { locate, readSchema } from "./project.ts";
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
    throw error instanceof ApprovalRequiredError
      ? approvalRequired(error, context.agent, pushing)
      : schemaRefusal(layout, error);
  }
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
      lines: manual.map(({ object, reason }) => `  by hand: ${object}: ${reason}`),
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
