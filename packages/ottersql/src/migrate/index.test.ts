import { describe, expect, test } from "vitest";

describe("ottersql/migrate", () => {
  test("exports what users call, not what the command uses inside the package", async () => {
    const entryPoint: object = await import("./index.ts");
    expect(Object.keys(entryPoint).toSorted()).toStrictEqual([
      "ApprovalRequiredError",
      "LockWaitTimeoutError",
      "MigrationFileError",
      "MigrationHistoryError",
      "SessionChangedError",
      "applyMigrations",
      "baselineMigrations",
      "migrationStatus",
      "nextMigrationName",
      "pendingChanges",
      "planBaseline",
      "planMigration",
      "pushSchema",
      "readMigrationFile",
      "renderMigration",
    ]);
  });
});
