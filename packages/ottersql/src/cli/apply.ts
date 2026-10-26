import { join } from "node:path";

import { applyMigrations, ApprovalRequiredError } from "../migrate/index.ts";
import type { ApplyOptions, ApplyResult } from "../migrate/index.ts";
import { approvalRequired, refuseApprovalByAgent } from "./approval.ts";
import type { Approvable } from "./approval.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { withSession } from "./database.ts";
import type { Outcome } from "./outcome.ts";
import { sqlstateNote } from "./outcome.ts";
import { migrationRefusal, locate, readMigrations, shown } from "./project.ts";
import type { Layout } from "./project.ts";

type Apply = Extract<Command, { name: "migrate apply" }>;

const applying: Approvable = { command: "ottersql migrate apply", namespace: "migrate" };

/**
 * Applies the pending migration steps to DATABASE_URL. Steps that cannot be undone wait for a
 * person's approval, which an AI agent cannot give.
 */
export async function apply(context: Context, command: Apply): Promise<Outcome> {
  refuseApprovalByAgent(context, command.approve, applying);
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
    ? approvalRequired(error, agent, applying)
    : migrationRefusal(error, layout);
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
    why: `Step ${String(failed.step)} of ${failed.migration} failed: ${failed.message}${sqlstateNote(failed.code)}`,
    fix: "Fix the cause, then apply again; it resumes at this step",
    where: { file: shown(layout, join(layout.migrationsDirectory, failed.migration)) },
    result: { applied, failed },
    lines,
  };
}
