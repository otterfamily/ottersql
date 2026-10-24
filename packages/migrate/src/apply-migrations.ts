import { createHash } from "node:crypto";

import type { Connection } from "@ottersql/sql";

import { checkApproval } from "./approval.ts";
import { exclusively, readLedger } from "./ledger.ts";
import type { AppliedStep, PendingStep } from "./ledger.ts";
import { readMigration } from "./migration-file.ts";
import { inOrder } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import { phases } from "./plan.ts";
import type { Step } from "./plan.ts";
import { runStep } from "./run-step.ts";
import type { RunOptions, StepFailure } from "./run-step.ts";

export interface ApplyOptions extends RunOptions {
  /**
   * Only steps of this phase run: `expand` before the app deploys, `contract` after it. Steps run
   * in deploy order, each migration's contract before the next one's expand, so a run stops at
   * the first pending step of the other phase.
   */
  readonly phase?: Step["phase"];
  /**
   * The `approval` of an `ApprovalRequiredError`, given after a person reviewed the steps it lists;
   * it covers exactly the pending steps that error saw.
   */
  readonly approve?: string;
}

/** A step of a migration file, by the file's name and the step's index in it. */
export interface StepRef {
  readonly migration: string;
  readonly step: number;
}

export interface ApplyResult {
  readonly applied: readonly StepRef[];
  /** The step that failed, with Postgres's SQLSTATE; the steps after it did not run. */
  readonly failed: (StepRef & StepFailure) | null;
  /** The next pending step, when it belongs to the other phase and so waits for that run. */
  readonly waiting: (StepRef & Pick<Step, "phase">) | null;
}

/** The migration history and the files disagree, so applying them could leave an unknown schema. */
export class MigrationHistoryError extends Error {
  override readonly name = "MigrationHistoryError";
}

/**
 * Applies the steps of `files` that have not run on `connection`, which must be one session (a
 * `pg` Client or PoolClient, or PGlite) so that a transaction's statements share it. Steps run in
 * deploy order: file by file, a file's expand steps and then its contract steps. Each step is
 * recorded with its file's hash, so running again resumes after the last step that succeeded, and
 * a run started while another is applying waits for it to finish. Throws a
 * `MigrationHistoryError` before running anything when a file changed after it was applied, or
 * when a step that has not run comes before one that has, as a new file older than applied ones
 * does; and an `ApprovalRequiredError` when a pending step cannot be undone and `options.approve`
 * does not cover the pending steps.
 */
export async function applyMigrations(
  connection: Connection,
  files: readonly MigrationFile[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  return exclusively(connection, async () => {
    const history = await readLedger(connection);
    const unapplied = notYetApplied(deployOrder(files), history);
    const phase = options.phase ?? null;
    const end = unapplied.findIndex(({ step }) => phase !== null && step.phase !== phase);
    const pending = end === -1 ? unapplied : unapplied.slice(0, end);
    checkApproval(pending, options.approve);
    const result = await runInOrder(connection, pending, options);
    const next = end === -1 || result.failed !== null ? undefined : unapplied[end];
    return {
      ...result,
      waiting:
        next === undefined
          ? null
          : { migration: next.migration, step: next.index, phase: next.step.phase },
    };
  });
}

/** Every step of `files`: file by file, each file's expand steps before its contract steps. */
function deployOrder(files: readonly MigrationFile[]): PendingStep[] {
  return inOrder(files).flatMap((file) => {
    const hash = createHash("sha256").update(file.text).digest("hex");
    return readMigration(file)
      .map((step, index) => ({ migration: file.name, hash, index, step }))
      .toSorted(
        (left, right) => phases.indexOf(left.step.phase) - phases.indexOf(right.step.phase),
      );
  });
}

/**
 * The steps of `steps` that have not run, after checking that the history is a prefix of them:
 * every step that ran comes before every step that has not, and its file is unchanged.
 */
function notYetApplied(
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
        `${migration} was edited after it was applied; add a new migration instead`,
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

/** Runs steps until one fails. */
async function runInOrder(
  connection: Connection,
  pending: readonly PendingStep[],
  options: RunOptions,
): Promise<Omit<ApplyResult, "waiting">> {
  const applied: StepRef[] = [];
  for (const step of pending) {
    const failure = await runStep(connection, step, options);
    const ref = { migration: step.migration, step: step.index };
    if (failure !== null) {
      return { applied, failed: { ...ref, ...failure } };
    }
    applied.push(ref);
  }
  return { applied, failed: null };
}
