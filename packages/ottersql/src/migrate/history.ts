import { createHash } from "node:crypto";

import type { AppliedStep, PendingStep } from "./ledger.ts";
import { readMigration } from "./migration-file.ts";
import { inOrder } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import { phases } from "./plan.ts";
import type { Step } from "./plan.ts";

/** The migration history and the files disagree, so applying them could leave an unknown schema. */
export class MigrationHistoryError extends Error {
  override readonly name = "MigrationHistoryError";
}

/** Every step of `files`: file by file, each file's expand steps before its contract steps. */
export function deployOrder(files: readonly MigrationFile[]): PendingStep[] {
  return inOrder(files).flatMap((file) =>
    readMigration(file)
      .map((step, index) => ({ migration: file.name, hash: stepHash(step), index, step }))
      .toSorted(
        (left, right) => phases.indexOf(left.step.phase) - phases.indexOf(right.step.phase),
      ),
  );
}

/**
 * What identifies a step once it ran: everything that decides what it does, so comments and line
 * endings may change, and a step that has not run may be fixed.
 */
export function stepHash(step: Step): string {
  const { kind, object, phase, reversal, transaction, lock, statements } = step;
  const cleanup = step.transaction === "outside" ? step.cleanup : null;
  return createHash("sha256")
    .update(JSON.stringify([kind, object, phase, reversal, transaction, lock, statements, cleanup]))
    .digest("hex");
}

/**
 * The steps of `steps` that have not run, after checking that the history is a prefix of them:
 * every step that ran comes before every step that has not, and its file is unchanged.
 */
export function notYetApplied(
  steps: readonly PendingStep[],
  history: readonly AppliedStep[],
): PendingStep[] {
  const applied = new Map(
    history.map(({ migration, step, hash }) => [`${migration}#${String(step)}`, hash]),
  );
  const ran = steps.map(({ migration, index, hash }) => {
    const recorded = applied.get(`${migration}#${String(index)}`);
    if (recorded !== undefined && recorded !== hash) {
      throw new MigrationHistoryError(
        `${migration} step ${String(index)} was edited after it was applied; add a new migration instead`,
      );
    }
    return recorded !== undefined;
  });
  const first = ran.indexOf(false);
  const later = first === -1 ? -1 : ran.indexOf(true, first);
  const [notRun, run] = [steps[first], steps[later]];
  if (notRun !== undefined && run !== undefined) {
    throw new MigrationHistoryError(
      notRun.migration === run.migration
        ? `${notRun.migration} step ${String(notRun.index)} has not run, but step ${String(run.index)} after it has; add a new migration instead`
        : `${notRun.migration} is older than ${run.migration}, which was applied; regenerate it on top of the applied migrations`,
    );
  }
  return first === -1 ? [] : steps.slice(first);
}
