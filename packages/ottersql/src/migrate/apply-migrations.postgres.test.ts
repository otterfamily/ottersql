import { setTimeout as sleep } from "node:timers/promises";

import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import type { PgClient } from "../sql/pg-driver.ts";
import { pgConnection } from "../sql/pg.ts";
import { applyMigrations, LockWaitTimeoutError, SessionChangedError } from "./index.ts";
import { connect, migrationFrom, step, users } from "./test-migrate.ts";

/** A client whose statements take turns on two sessions, as a pooler in transaction mode may send them. */
function alternating(first: PgClient, second: PgClient): PgClient {
  let sent = 0;
  return {
    query: async (config) => {
      sent += 1;
      const session = sent % 2 === 1 ? first : second;
      return session.query(config);
    },
  };
}

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

  test("gives up waiting for another run's lock after waitForOtherRuns, naming the session that holds it", async () => {
    const url = await postgresDatabase(users);
    const [migrator, holder] = await Promise.all([connect(url), connect(url)]);
    try {
      const { rows } = await holder.query<{ pid: number }>(
        "select pg_backend_pid() as pid, pg_advisory_lock(hashtextextended('ottersql.applied_steps', 0))",
      );
      const file = await migrationFrom(users, `${users}; alter table users add column name text`);
      const waiting = applyMigrations(pgConnection(migrator), [file], { waitForOtherRuns: 300 });
      await expect(waiting).rejects.toThrow(LockWaitTimeoutError);
      await expect(waiting).rejects.toMatchObject({ holder: rows[0]?.pid });
    } finally {
      await Promise.all([migrator.end(), holder.end()]);
    }
  });

  test("waits for another run on the same session too, which a pooler may hand both runs", async () => {
    const url = await postgresDatabase(users);
    const shared = await connect(url);
    try {
      await shared.query("select pg_advisory_lock(hashtextextended('ottersql.applied_steps', 0))");
      const file = await migrationFrom(users, `${users}; alter table users add column name text`);
      await expect(
        applyMigrations(pgConnection(shared), [file], { waitForOtherRuns: 300 }),
      ).rejects.toThrow(LockWaitTimeoutError);
    } finally {
      await shared.end();
    }
  });

  test("refuses to run when the connection changes session after taking the lock, as through a transaction-mode pooler", async () => {
    const url = await postgresDatabase(users);
    const [first, second] = await Promise.all([connect(url), connect(url)]);
    try {
      const file = await migrationFrom(users, `${users}; alter table users add column name text`);
      const connection = pgConnection(alternating(first, second));
      await expect(applyMigrations(connection, [file])).rejects.toThrow(SessionChangedError);
      const { rows } = await first.query(
        "select count(*)::int as columns from information_schema.columns where table_name = 'users'",
      );
      expect(rows).toStrictEqual([{ columns: 2 }]);
    } finally {
      await Promise.all([first.end(), second.end()]);
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
