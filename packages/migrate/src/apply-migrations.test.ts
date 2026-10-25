import { loadCatalog, openSchema } from "@ottersql/catalog";
import { pgliteConnection } from "@ottersql/sql/pglite";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "./index.ts";
import type { MigrationFile } from "./index.ts";
import { migrationFrom, step, users, withSortedColumns } from "./test-migrate.ts";

const target = `create table users (id int8 primary key, email text not null unique);
  create index users_email_lower on users (lower(email));`;

function newer(file: MigrationFile): MigrationFile {
  return { name: "20261026000000_change.sql", text: file.text };
}

function header(kind: string, object: string): string {
  return `-- ottersql:step kind=${kind} object="${object}" phase=expand reversal=lossy transaction=inside lock="none"`;
}

describe("applyMigrations on PGlite", () => {
  test("brings the database to the target schema, and skips what it already applied", async () => {
    const schema = await openSchema(users);
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
    const schema = await openSchema(users);
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
    const schema = await openSchema(nullable);
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
    const schema = await openSchema("");
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
  ])("refuses $problem", async ({ first, later, message }) => {
    const schema = await openSchema(users);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, `${users}; create index on users (email)`);
      await applyMigrations(connection, first(file));
      await expect(applyMigrations(connection, later(file))).rejects.toThrow(message);
    } finally {
      await schema.close();
    }
  });
});
