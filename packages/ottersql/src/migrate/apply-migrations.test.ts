import { describe, expect, test } from "vitest";

import { loadCatalog, openSchema } from "../catalog/index.ts";
import { driverConnection, rawQuery, sqlTransaction, transactionModeSql } from "../sql/driver.ts";
import type { DriverQuery } from "../sql/driver.ts";
import type { Connection } from "../sql/index.ts";
import { pgliteConnection } from "../sql/pglite.ts";
import { applyMigrations } from "./index.ts";
import type { MigrationFile } from "./index.ts";
import { migratedObjects } from "./ledger.ts";
import { migrationFrom, step, users, withSortedColumns } from "./test-migrate.ts";

const target = `create table users (id int8 primary key, email text not null unique);
  create index users_email_lower on users (lower(email));`;

function newer(file: MigrationFile): MigrationFile {
  return { name: "20261026000000_change.sql", text: file.text };
}

/** A migration file written by hand, a step for each statement. */
function handWritten(statements: readonly string[]): MigrationFile {
  return {
    name: "20261026120000_by_hand.sql",
    text: statements.map((sql) => `${header("custom", "public.users")}\n${sql};\n`).join(""),
  };
}

function header(kind: string, object: string): string {
  return `-- ottersql:step kind=${kind} object="${object}" phase=expand reversal=lossy transaction=inside lock="none"`;
}

/** `connection`, but a statement that contains `fragment` fails as a dropped network connection does. */
function droppingOn(connection: Connection, fragment: string): Connection {
  const query: DriverQuery = async (sql, parameters) => {
    if (sql.toLowerCase().includes(fragment)) {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    }
    return rawQuery(connection, sql, parameters);
  };
  return driverConnection({
    query,
    transaction: async (run, mode) => {
      await query(`begin ${transactionModeSql(mode)}`, []);
      try {
        const result = await run(sqlTransaction(query));
        await query("commit", []);
        return result;
      } catch (error) {
        await query("rollback", []);
        throw error;
      }
    },
  });
}

describe("applyMigrations on PGlite", () => {
  test("brings the database to the target schema, and skips what it already applied", async () => {
    const schema = await openSchema(users, migratedObjects);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, target);
      const first = await applyMigrations(connection, [file]);
      const second = await applyMigrations(connection, [file]);
      expect({
        applied: first.applied.length,
        second,
        after: withSortedColumns(await schema.readCatalog()),
      }).toStrictEqual({
        applied: 6,
        second: { applied: [], failed: null, waiting: null },
        after: withSortedColumns(await loadCatalog(target)),
      });
    } finally {
      await schema.close();
    }
  });

  test("runs one phase at a time: expand before the deploy, contract after", async () => {
    const schema = await openSchema(users, migratedObjects);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(
        users,
        "create table users (id int8 primary key, email text, name text not null)",
      );
      const expand = await applyMigrations(connection, [file], { phase: "expand" });
      const contract = await applyMigrations(connection, [file], { phase: "contract" });
      expect({ expand, contract }).toStrictEqual({
        expand: {
          applied: [step(file.name, 0)],
          failed: null,
          waiting: { ...step(file.name, 1), phase: "contract" },
        },
        contract: {
          applied: [step(file.name, 1), step(file.name, 2), step(file.name, 3)],
          failed: null,
          waiting: null,
        },
      });
    } finally {
      await schema.close();
    }
  });

  test("runs one migration's contract steps before the next migration's expand steps", async () => {
    const nullable = "create table users (id int8 primary key, email text)";
    const required = "create table users (id int8 primary key, email text not null)";
    const schema = await openSchema(nullable, migratedObjects);
    try {
      const connection = pgliteConnection(schema.database);
      const files = [
        await migrationFrom(nullable, required, "20261025000000_require.sql"),
        await migrationFrom(required, nullable, "20261026000000_relax.sql"),
      ];
      const firstExpand = await applyMigrations(connection, files, { phase: "expand" });
      const contract = await applyMigrations(connection, files, { phase: "contract" });
      const secondExpand = await applyMigrations(connection, files, { phase: "expand" });
      const after = await schema.readCatalog();
      expect({
        firstExpand,
        contract,
        secondExpand,
        emailNotNull: after.tables[0]?.columns.find(({ name }) => name === "email")?.notNull,
      }).toStrictEqual({
        firstExpand: {
          applied: [],
          failed: null,
          waiting: { ...step("20261025000000_require.sql", 0), phase: "contract" },
        },
        contract: {
          applied: [0, 1, 2].map((index) => step("20261025000000_require.sql", index)),
          failed: null,
          waiting: { ...step("20261026000000_relax.sql", 0), phase: "expand" },
        },
        secondExpand: {
          applied: [step("20261026000000_relax.sql", 0)],
          failed: null,
          waiting: null,
        },
        emailNotNull: false,
      });
    } finally {
      await schema.close();
    }
  });

  test("lets a step that has not run be fixed in a migration that partly ran", async () => {
    const schema = await openSchema("", migratedObjects);
    try {
      const connection = pgliteConnection(schema.database);
      const broken = {
        name: "20261025000000_logs.sql",
        text: [
          header("createTable", "public.logs"),
          "create table logs (id int8);",
          header("custom", "public.logs"),
          "insert into log values (1);",
        ].join("\n"),
      };
      const fixed = {
        ...broken,
        text: `-- Comments may change too.\n${broken.text.replace("into log ", "into logs ")}`,
      };
      const failed = await applyMigrations(connection, [broken]);
      const resumed = await applyMigrations(connection, [fixed]);
      expect({ failed: failed.failed?.code, resumed }).toStrictEqual({
        failed: "42P01",
        resumed: { applied: [step(broken.name, 1)], failed: null, waiting: null },
      });
    } finally {
      await schema.close();
    }
  });

  test.for([
    {
      problem: "a migration edited after it was applied",
      first: (file: MigrationFile): MigrationFile[] => [file],
      later: (file: MigrationFile): MigrationFile[] => [
        { ...file, text: file.text.replace('("email")', '("email", "id")') },
      ],
      message:
        "20261025000000_change.sql step 0 was edited after it was applied; add a new migration instead",
    },
    {
      problem: "a new migration older than one already applied",
      first: (file: MigrationFile): MigrationFile[] => [newer(file)],
      later: (file: MigrationFile): MigrationFile[] => [file, newer(file)],
      message:
        "20261025000000_change.sql is older than 20261026000000_change.sql, which was applied; regenerate it on top of the applied migrations",
    },
    {
      problem: "an applied migration that is gone",
      first: (file: MigrationFile): MigrationFile[] => [file],
      later: (): MigrationFile[] => [],
      message:
        "20261025000000_change.sql step 0 was applied, but no migration file has it; restore the file",
    },
    {
      problem: "an applied step that is gone from its migration",
      first: (): MigrationFile[] => [handWritten(["select 1", "select 2"])],
      later: (): MigrationFile[] => [handWritten(["select 1"])],
      message:
        "20261026120000_by_hand.sql step 1 was applied, but no migration file has it; restore the file",
    },
  ])("refuses $problem", async ({ first, later, message }) => {
    const schema = await openSchema(users, migratedObjects);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, `${users}; create index on users (email)`);
      await applyMigrations(connection, first(file));
      await expect(applyMigrations(connection, later(file))).rejects.toThrow(message);
    } finally {
      await schema.close();
    }
  });

  test("throws an error that did not come from Postgres, as it is, instead of reporting a failed step", async () => {
    const schema = await openSchema(users, migratedObjects);
    try {
      const connection = droppingOn(pgliteConnection(schema.database), "add column");
      const file = await migrationFrom(users, `${users}; alter table users add column name text`);
      await expect(applyMigrations(connection, [file])).rejects.toThrow("read ECONNRESET");
    } finally {
      await schema.close();
    }
  });

  test.for([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "refuses to wait %s milliseconds for another run",
    async (wait) => {
      const schema = await openSchema(users, migratedObjects);
      try {
        const connection = pgliteConnection(schema.database);
        await expect(applyMigrations(connection, [], { waitForOtherRuns: wait })).rejects.toThrow(
          RangeError,
        );
      } finally {
        await schema.close();
      }
    },
  );
});
