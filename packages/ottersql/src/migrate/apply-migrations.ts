import type { Connection } from "../sql/index.ts";
import { checkApproval } from "./approval.ts";
import { deployOrder, notYetApplied } from "./history.ts";
import { createLedger, readLedger, record } from "./ledger.ts";
import type { PendingStep } from "./ledger.ts";
import type { MigrationFile } from "./migration-file.ts";
import type { Step } from "./plan.ts";
import { exclusively } from "./run-lock.ts";
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
  /**
   * How long to wait for another run that is applying migrations to the same database, in
   * milliseconds, before throwing a `LockWaitTimeoutError`: by default 10 minutes.
   */
  readonly waitForOtherRuns?: number;
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

/**
 * Applies the steps of `files` that have not run on `connection`, which must be one session (a
 * `pg` Client or PoolClient, or PGlite) so that a transaction's statements share it. Steps run in
 * deploy order: file by file, a file's expand steps and then its contract steps. Each step is
 * recorded with a hash of what it does, so running again resumes after the last step that
 * succeeded, and a run started while another is applying waits for it to finish, up to
 * `options.waitForOtherRuns`. Throws a `MigrationHistoryError` before running anything when a
 * step changed after it was applied, or when a step that has not run comes before one that has,
 * as a new file older than applied ones does; and an `ApprovalRequiredError` when a pending step
 * cannot be undone and `options.approve` does not cover the pending steps.
 */
export async function applyMigrations(
  connection: Connection,
  files: readonly MigrationFile[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  return exclusively(
    connection,
    async () => {
      await createLedger(connection);
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
    },
    options.waitForOtherRuns,
  );
}

/** Runs steps until one fails. */
async function runInOrder(
  connection: Connection,
  pending: readonly PendingStep[],
  options: RunOptions,
): Promise<Omit<ApplyResult, "waiting">> {
  const applied: StepRef[] = [];
  for (const step of pending) {
    const failure = await runStep(
      connection,
      { step: step.step, done: async (db) => record(db, step) },
      options,
    );
    const ref = { migration: step.migration, step: step.index };
    if (failure !== null) {
      return { applied, failed: { ...ref, ...failure } };
    }
    applied.push(ref);
  }
  return { applied, failed: null };
}
