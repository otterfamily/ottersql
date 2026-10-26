import { setTimeout as sleep } from "node:timers/promises";

import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { pgConnection } from "../sql/pg.ts";
import { applyMigrations } from "./index.ts";
import { connect, migrationFrom, step, users } from "./test-migrate.ts";

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
        result: { applied: [step(file.name, 0)], failed: null, waiting: null },
        readerWaitedUnderASecond: true,
      });
    } finally {
      await Promise.all([migrator.end(), holder.end(), reader.end()]);
    }
  });

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
          waiting: null,
        },
        resumed: { applied: [step(file.name, 1), step(file.name, 2)], failed: null, waiting: null },
      });
    } finally {
      await client.end();
    }
  });
});
