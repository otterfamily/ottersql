import { setTimeout as sleep } from "node:timers/promises";

import { loadCatalog, openSchema } from "@ottersql/catalog";
import { pgConnection } from "@ottersql/sql/pg";
import { pgliteConnection } from "@ottersql/sql/pglite";
import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { applyMigrations, planMigration, renderMigration } from "./index.ts";
import type { MigrationFile } from "./index.ts";
import { users, withSortedColumns } from "./test-migrate.ts";

const target = `create table users (id int8 primary key, email text not null unique);
  create index users_email_lower on users (lower(email));`;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** A migration file from the users table to `toSql`. */
async function migrationFrom(
  fromSql: string,
  toSql: string,
  name = "20261025000000_change.sql",
): Promise<MigrationFile> {
  const plan = planMigration(await loadCatalog(fromSql), await loadCatalog(toSql));
  return { name, text: renderMigration(plan) };
}

function newer(file: MigrationFile): MigrationFile {
  return { name: "20261026000000_change.sql", text: file.text };
}

const step = (migration: string, index: number): { migration: string; step: number } => ({
  migration,
  step: index,
});

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
        second: { applied: [], failed: null },
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
        expand: { applied: [step(file.name, 0)], failed: null },
        contract: {
          applied: [step(file.name, 1), step(file.name, 2), step(file.name, 3)],
          failed: null,
        },
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
        { ...file, text: `${file.text}\n-- edited\n` },
      ],
      message:
        "20261025000000_change.sql was edited after it was applied; add a new migration instead",
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

describe("applyMigrations on Postgres", () => {
  test("gives up a lock it waits for, so queries queued behind it go on, and retries until it gets it", async () => {
    const url = await postgresDatabase(users);
    const [migrator, holder, reader] = await Promise.all([
      connect(url),
      connect(url),
      connect(url),
    ]);
    try {
      await holder.query("begin; select * from users");
      const file = await migrationFrom(users, `${users}; alter table users add column name text`);
      const applying = applyMigrations(pgConnection(migrator), [file], {
        lockTimeout: 200,
        retries: 50,
        retryDelay: () => 100,
      });
      await sleep(300);
      const started = performance.now();
      await reader.query("select count(*) from users");
      const readerWaited = performance.now() - started;
      await holder.query("commit");
      expect({
        result: await applying,
        readerWaitedUnderASecond: readerWaited < 1000,
      }).toStrictEqual({
        result: { applied: [step(file.name, 0)], failed: null },
        readerWaitedUnderASecond: true,
      });
    } finally {
      await Promise.all([migrator.end(), holder.end(), reader.end()]);
    }
  }, 30_000);

  test("stops at a step that fails, and resumes there once the data is fixed", async () => {
    const url = await postgresDatabase(`${users}; insert into users values (1, null)`);
    const client = await connect(url);
    try {
      const connection = pgConnection(client);
      const file = await migrationFrom(
        users,
        "create table users (id int8 primary key, email text not null)",
      );
      const failed = await applyMigrations(connection, [file]);
      await client.query("update users set email = 'otter@example.com'");
      const resumed = await applyMigrations(connection, [file]);
      expect({ failed, resumed }).toStrictEqual({
        failed: {
          applied: [step(file.name, 0)],
          failed: {
            ...step(file.name, 1),
            code: "23514",
            message:
              'check constraint "ottersql_not_null_email" of relation "users" is violated by some row',
          },
        },
        resumed: { applied: [step(file.name, 1), step(file.name, 2)], failed: null },
      });
    } finally {
      await client.end();
    }
  }, 30_000);

  test("rebuilds an index a failed concurrent build left invalid", async () => {
    const url = await postgresDatabase(`${users}; insert into users values (1, 'a'), (2, 'a')`);
    const client = await connect(url);
    try {
      const connection = pgConnection(client);
      const file = await migrationFrom(
        users,
        "create table users (id int8 primary key, email text unique)",
      );
      const failed = await applyMigrations(connection, [file]);
      await client.query("delete from users where id = 2");
      const resumed = await applyMigrations(connection, [file]);
      const { rows } = await client.query<{ valid: boolean }>(
        "select indisvalid as valid from pg_index where indexrelid = 'users_email_key'::regclass",
      );
      expect({ failed: failed.failed?.code, resumed, rows }).toStrictEqual({
        failed: "23505",
        resumed: { applied: [step(file.name, 0), step(file.name, 1)], failed: null },
        rows: [{ valid: true }],
      });
    } finally {
      await client.end();
    }
  }, 30_000);
});
