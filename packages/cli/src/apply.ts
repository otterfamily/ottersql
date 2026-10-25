import { join } from "node:path";

import { applyMigrations, ApprovalRequiredError } from "@ottersql/migrate";
import type { ApplyOptions, ApplyResult } from "@ottersql/migrate";

import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import { CommandError } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";
import { historyRefusal, locate, readMigrations, shown } from "./project.ts";
import type { Layout } from "./project.ts";

type Apply = Extract<Command, { name: "migrate apply" }>;

/**
 * Applies the pending migration steps to DATABASE_URL. Steps that cannot be undone wait for a
 * person's approval, which an AI agent cannot give.
 */
export async function apply(context: Context, command: Apply): Promise<Outcome> {
  if (context.agent !== null && command.approve !== null) {
    throw new CommandError({
      kind: "approval",
      code: "migrate.approval_by_agent",
      why: `${context.agent} is an AI agent, and only a person can approve steps that cannot be undone`,
      fix: "Show the steps to the user and ask them to run the command with --approve in their own terminal",
    });
  }
  const layout = await locate(context.cwd, command.project);
  const files = await readMigrations(layout);
  try {
    const result = await withSession(context.env, async (connection) =>
      applyMigrations(connection, files, applyOptions(command)),
    );
    return reported(layout, result);
  } catch (error) {
    throw refusal(error, layout, context.agent);
  }
}

function applyOptions({ phase, approve }: Apply): ApplyOptions {
  return { ...(phase === null ? {} : { phase }), ...(approve === null ? {} : { approve }) };
}

/** The refusal `error` stands for, or `error` itself when it is not one. */
function refusal(error: unknown, layout: Layout, agent: string | null): unknown {
  return error instanceof ApprovalRequiredError
    ? approvalRequired(error, agent)
    : historyRefusal(error, layout);
}

function approvalRequired(
  { approval, steps }: Pick<ApprovalRequiredError, "approval" | "steps">,
  agent: string | null,
): CommandError {
  const run = `ottersql migrate apply --approve ${approval}`;
  return new CommandError({
    kind: "approval",
    code: "migrate.approval_required",
    why: `${String(steps.length)} pending steps cannot be undone`,
    fix:
      agent === null
        ? `Review the steps, then run \`${run}\``
        : `Show the steps to the user and ask them to run \`${run}\` in their own terminal; an agent cannot approve them`,
    result: { approval, steps },
    lines: steps.map(
      ({ migration, step, kind, object }) =>
        `  ${migration} step ${String(step)}: ${kind} ${object}`,
    ),
  });
}

function reported(layout: Layout, { applied, failed, waiting }: ApplyResult): Outcome {
  const lines = applied.map(({ migration, step }) => `  applied ${migration} step ${String(step)}`);
  if (failed === null) {
    return {
      ok: true,
      result: { applied, waiting },
      lines: [
        `Applied ${String(applied.length)} steps`,
        ...lines,
        ...(waiting === null
          ? []
          : [
              `Next: ${waiting.migration} step ${String(waiting.step)} runs with --phase ${waiting.phase}`,
            ]),
      ],
    };
  }
  return {
    ok: false,
    kind: "failed",
    code: "migrate.step_failed",
    why: `Step ${String(failed.step)} of ${failed.migration} failed: ${failed.message} (SQLSTATE ${String(failed.code)})`,
    fix: "Fix the cause, then apply again; it resumes at this step",
    where: { file: shown(layout, join(layout.migrationsDirectory, failed.migration)) },
    result: { applied, failed },
    lines,
  };
}
