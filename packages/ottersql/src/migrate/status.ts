import { readCatalog } from "../catalog/index.ts";
import type { Connection } from "../sql/index.ts";
import type { StepRef } from "./apply-migrations.ts";
import { deployOrder, notYetApplied } from "./history.ts";
import { migratedObjects, readLedger } from "./ledger.ts";
import { replay } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import { planMigration } from "./plan-migration.ts";
import type { Plan, Step } from "./plan.ts";

/** A step of the migration files, and whether it ran on the database. */
export interface StepStatus extends StepRef, Pick<Step, "kind" | "object" | "phase"> {
  readonly applied: boolean;
}

export interface MigrationStatus {
  /** Every step, in the order they run. */
  readonly steps: readonly StepStatus[];
  /**
   * What turns the schema the applied steps build into the database's own, such as a column added
   * by hand; `null` when they match.
   */
  readonly drift: Plan | null;
}

/**
 * Which steps of `files` ran on `connection`, and whether the database is what those steps build.
 * Writes nothing. The steps that ran are replayed in PGlite and compared with the database's
 * catalog, so a change made outside the migrations shows up however it was made. Throws a
 * `MigrationHistoryError` when the history and the files disagree, as applying them would.
 */
export async function migrationStatus(
  connection: Connection,
  files: readonly MigrationFile[],
): Promise<MigrationStatus> {
  const steps = deployOrder(files);
  const pending = new Set(notYetApplied(steps, await readLedger(connection)));
  const applied = steps.filter((step) => !pending.has(step));
  const expected = await replay(applied.flatMap(({ step }) => step.statements));
  const drift = planMigration(expected, await readCatalog(connection, migratedObjects));
  return {
    steps: steps.map((each) => ({
      migration: each.migration,
      step: each.index,
      kind: each.step.kind,
      object: each.step.object,
      phase: each.step.phase,
      applied: !pending.has(each),
    })),
    drift: drift.steps.length === 0 && drift.manual.length === 0 ? null : drift,
  };
}
