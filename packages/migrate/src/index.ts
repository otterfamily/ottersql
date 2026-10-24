export { applyMigrations, MigrationHistoryError } from "./apply-migrations.ts";
export type { ApplyOptions, ApplyResult, StepRef } from "./apply-migrations.ts";
export { MigrationFileError, readMigrationFile, renderMigration } from "./migration-file.ts";
export { pendingChanges } from "./migrations.ts";
export type { MigrationFile } from "./migrations.ts";
export { planMigration } from "./plan-migration.ts";
export type { Lock, ManualChange, Plan, Step, StepKind } from "./plan.ts";
