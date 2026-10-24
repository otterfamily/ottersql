import { setTimeout as sleep } from "node:timers/promises";

import { loadCatalog, openSchema } from "@ottersql/catalog";
import { pgConnection } from "@ottersql/sql/pg";
import { pgliteConnection } from "@ottersql/sql/pglite";
import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { applyPlan, planMigration } from "./index.ts";
import type { Plan } from "./index.ts";
import { users, withSortedColumns } from "./test-migrate.ts";

const target = `create table users (id int8 primary key, email text not null unique);
  create index users_email_lower on users (lower(email));`;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function planFromUsers(toSql: string): Promise<Plan> {
  return planMigration(await loadCatalog(users), await loadCatalog(toSql));
}

describe("applyPlan", () => {
  test("brings the database to the target schema, and skips what it already applied", async () => {
    const schema = await openSchema(users);
    try {
      const connection = pgliteConnection(schema.database);
      const plan = planMigration(schema.catalog, await loadCatalog(target));
      const first = await applyPlan(connection, plan);
      const second = await applyPlan(connection, plan);
      expect({
        first,
        second,
        after: withSortedColumns(await schema.readCatalog()),
      }).toStrictEqual({
        first: { applied: [0, 1, 2, 3, 4, 5], skipped: [], failed: null },
        second: { applied: [], skipped: [0, 1, 2, 3, 4, 5], failed: null },
        after: withSortedColumns(await loadCatalog(target)),
      });
    } finally {
      await schema.close();
    }
  });

  test("gives up a lock it waits for, so queries queued behind it go on, and retries until it gets it", async () => {
    const url = await postgresDatabase(users);
    const [migrator, holder, reader] = await Promise.all([
      connect(url),
      connect(url),
      connect(url),
    ]);
    try {
      await holder.query("begin; select * from users");
      const plan = await planFromUsers(`${users}; alter table users add column name text`);
      const applying = applyPlan(pgConnection(migrator), plan, {
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
        result: { applied: [0], skipped: [], failed: null },
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
      const plan = await planFromUsers(
        "create table users (id int8 primary key, email text not null)",
      );
      const failed = await applyPlan(connection, plan);
      await client.query("update users set email = 'otter@example.com'");
      const resumed = await applyPlan(connection, plan);
      expect({ failed, resumed }).toStrictEqual({
        failed: {
          applied: [0],
          skipped: [],
          failed: {
            step: 1,
            code: "23514",
            message:
              'check constraint "ottersql_not_null_email" of relation "users" is violated by some row',
          },
        },
        resumed: { applied: [1, 2], skipped: [0], failed: null },
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
      const plan = await planFromUsers(
        "create table users (id int8 primary key, email text unique)",
      );
      const failed = await applyPlan(connection, plan);
      await client.query("delete from users where id = 2");
      const resumed = await applyPlan(connection, plan);
      const { rows } = await client.query<{ valid: boolean }>(
        "select indisvalid as valid from pg_index where indexrelid = 'users_email_key'::regclass",
      );
      expect({ failed: failed.failed?.code, resumed, rows }).toStrictEqual({
        failed: "23505",
        resumed: { applied: [0, 1], skipped: [], failed: null },
        rows: [{ valid: true }],
      });
    } finally {
      await client.end();
    }
  }, 30_000);
});
