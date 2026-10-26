import { readCatalog } from "../catalog/index.ts";
import type { Connection } from "../sql/index.ts";
import { deployOrder, MigrationHistoryError } from "./history.ts";
import { migratedObjects, readLedger, recordAll } from "./ledger.ts";
import { replay } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import { planMigration } from "./plan-migration.ts";
import type { Plan } from "./plan.ts";
import { exclusively } from "./run-lock.ts";

/**
 * The steps that build the database `connection` reaches from an empty one: the first migration
 * of a project that starts from an existing database. Objects ottersql does not plan, such as
 * functions, are listed in `manual` for a person to write as steps.
 */
export async function planBaseline(connection: Connection): Promise<Plan> {
  return planMigration(await replay([]), await readCatalog(connection, migratedObjects));
}

/**
 * Records every step of `files` as applied, running none of them, when replaying them in PGlite
 * builds exactly the database's schema; otherwise records nothing and returns what turns the one
 * into the other. Throws a `MigrationHistoryError` when the database already ran migrations.
 */
export async function baselineMigrations(
  connection: Connection,
  files: readonly MigrationFile[],
): Promise<Plan | null> {
  return exclusively(connection, async () => {
    const history = await readLedger(connection);
    if (history.length > 0) {
      throw new MigrationHistoryError(
        "The database already ran migrations; a baseline is for one that never did",
      );
    }
    const steps = deployOrder(files);
    const difference = planMigration(
      await replay(steps.flatMap(({ step }) => step.statements)),
      await readCatalog(connection, migratedObjects),
    );
    if (difference.steps.length > 0 || difference.manual.length > 0) {
      return difference;
    }
    await recordAll(connection, steps);
    return null;
  });
}
