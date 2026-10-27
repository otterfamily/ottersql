import { loadCatalog, readCatalog } from "../../catalog/index.ts";
import type { Connection } from "../../sql/index.ts";
import type { ManualChange, Step } from "../plan.ts";
import { planMigration } from "../planner/plan-migration.ts";
import type { ApplyOptions } from "./apply-migrations.ts";
import { checkApproval } from "./approval.ts";
import { MigrationHistoryError, stepHash } from "./history.ts";
import type { PendingStep } from "./ledger.ts";
import { hasLedger, migratedObjects } from "./ledger.ts";
import { exclusively } from "./run-lock.ts";
import { runStep } from "./run-step.ts";
import type { StepFailure } from "./run-step.ts";

export type PushOptions = Omit<ApplyOptions, "phase">;

export interface PushResult {
  readonly applied: readonly Step[];
  /** The step that failed, with Postgres's SQLSTATE; the steps after it did not run. */
  readonly failed: (StepFailure & Pick<Step, "kind" | "object">) | null;
  /** Changes left to a person; while there are any, no step runs. */
  readonly manual: readonly ManualChange[];
}

/**
 * Brings the database `connection` reaches to the schema `schemaSql` describes, running the planned
 * steps directly and recording none of them: for a database to try things on, never one that
 * migrations keep. Runs nothing while the plan leaves a change to a person, so the database is
 * never left half way; throws an `ApprovalRequiredError` when a step cannot be undone and
 * `options.approve` does not cover the plan, and a `MigrationHistoryError` for a database that
 * migrations keep. It holds the migrations' lock meanwhile, so it never runs beside them.
 */
export async function pushSchema(
  connection: Connection,
  schemaSql: string,
  options: PushOptions = {},
): Promise<PushResult> {
  return exclusively(
    connection,
    async () => {
      if (await hasLedger(connection)) {
        throw new MigrationHistoryError(
          "Migrations keep this database, so a push would leave it differing from them; write the change as a migration",
        );
      }
      return pushPlanned(connection, schemaSql, options);
    },
    options.waitForOtherRuns,
  );
}

async function pushPlanned(
  connection: Connection,
  schemaSql: string,
  options: PushOptions,
): Promise<PushResult> {
  const plan = planMigration(
    await readCatalog(connection, migratedObjects),
    await loadCatalog(schemaSql, migratedObjects),
  );
  if (plan.manual.length > 0) {
    return { applied: [], failed: null, manual: plan.manual };
  }
  const pending: PendingStep[] = plan.steps.map((step, index) => ({
    migration: "push",
    hash: stepHash(step),
    index,
    step,
  }));
  checkApproval(pending, options.approve);
  return runAll(connection, plan.steps, options);
}

async function runAll(
  connection: Connection,
  steps: readonly Step[],
  options: PushOptions,
): Promise<PushResult> {
  const applied: Step[] = [];
  for (const step of steps) {
    const failure = await runStep(connection, { step }, options);
    if (failure !== null) {
      return { applied, failed: { ...failure, kind: step.kind, object: step.object }, manual: [] };
    }
    applied.push(step);
  }
  return { applied, failed: null, manual: [] };
}
