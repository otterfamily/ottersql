import type { ApprovalRequiredError } from "@ottersql/migrate";

import type { Context } from "./context.ts";
import { CommandError } from "./outcome.ts";

/** A command that can run steps that cannot be undone: how to run it again, and its codes' namespace. */
export interface Approvable {
  readonly command: string;
  readonly namespace: string;
}

/** Only a person approves steps that cannot be undone, so an AI agent's --approve is refused. */
export function refuseApprovalByAgent(
  context: Context,
  approve: string | null,
  { namespace }: Approvable,
): void {
  if (context.agent !== null && approve !== null) {
    throw new CommandError({
      kind: "approval",
      code: `${namespace}.approval_by_agent`,
      why: `${context.agent} is an AI agent, and only a person can approve steps that cannot be undone`,
      fix: "Show the steps to the user and ask them to run the command with --approve in their own terminal",
    });
  }
}

export function approvalRequired(
  { approval, steps }: Pick<ApprovalRequiredError, "approval" | "steps">,
  agent: string | null,
  { command, namespace }: Approvable,
): CommandError {
  const run = `${command} --approve ${approval}`;
  return new CommandError({
    kind: "approval",
    code: `${namespace}.approval_required`,
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
