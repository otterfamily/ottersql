import { createHash } from "node:crypto";

import type { Connection } from "@ottersql/sql";

import { checkApproval } from "./approval.ts";
import { readLedger } from "./ledger.ts";
import type { AppliedStep, PendingStep } from "./ledger.ts";
import { readMigrationFile } from "./migration-file.ts";
import { inOrder } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import type { Step } from "./plan.ts";
import { runStep } from "./run-step.ts";
import type { RunOptions, StepFailure } from "./run-step.ts";

export interface ApplyOptions extends RunOptions {
  /** Only steps of this phase run: `expand` before the app deploys, `contract` after it. */
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
}

/** The migration history and the files disagree, so applying them could leave an unknown schema. */
export class MigrationHistoryError extends Error {
  override readonly name = "MigrationHistoryError";
}

interface HashedFile extends MigrationFile {
  readonly hash: string;
}

/**
 * Applies the steps of `files` that have not run, in file order, on `connection`, which must be
 * one session (a `pg` Client or PoolClient, or PGlite) so that a transaction's statements share
 * it. Each step is recorded with its file's hash, so running again resumes after the last step that
 * succeeded. Throws a `MigrationHistoryError` before running anything when a file changed after it
 * was applied, or when a file not yet applied is older than one that was, and an
 * `ApprovalRequiredError` when a pending step cannot be undone and `options.approve` does not cover
 * the pending steps.
 */
export async function applyMigrations(
  connection: Connection,
  files: readonly MigrationFile[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const history = await readLedger(connection);
  const hashed = inOrder(files).map((file) => ({
    name: file.name,
    text: file.text,
    hash: createHash("sha256").update(file.text).digest("hex"),
  }));
  checkHistory(hashed, history);
  const pending = pendingSteps(hashed, history, options.phase);
  checkApproval(pending, options.approve);
  return runInOrder(connection, pending, options);
}

function checkHistory(files: readonly HashedFile[], history: readonly AppliedStep[]): void {
  const newest = history
    .map(({ migration }) => migration)
    .toSorted()
    .at(-1);
  for (const file of files) {
    const applied = history.filter(({ migration }) => migration === file.name);
    if (applied.some(({ hash }) => hash !== file.hash)) {
      throw new MigrationHistoryError(
        `${file.name} was edited after it was applied; add a new migration instead`,
      );
    }
    if (applied.length === 0 && newest !== undefined && file.name < newest) {
      throw new MigrationHistoryError(
        `${file.name} is older than ${newest}, which was applied; regenerate it on top of the applied migrations`,
      );
    }
  }
}

function pendingSteps(
  files: readonly HashedFile[],
  history: readonly AppliedStep[],
  phase: Step["phase"] | undefined,
): PendingStep[] {
  const done = new Set(history.map(({ migration, step }) => `${migration}#${String(step)}`));
  return files.flatMap((file) =>
    readMigrationFile(file.text).flatMap((step, index) =>
      done.has(`${file.name}#${String(index)}`) || (phase !== undefined && step.phase !== phase)
        ? []
        : [{ migration: file.name, hash: file.hash, index, step }],
    ),
  );
}

/** Runs steps until one fails. */
async function runInOrder(
  connection: Connection,
  pending: readonly PendingStep[],
  options: RunOptions,
): Promise<ApplyResult> {
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
