import { setTimeout as sleep } from "node:timers/promises";

import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { pgConnection } from "../../sql/pg.ts";
import { applyMigrations } from "../index.ts";
import { connect, migrationFrom, step, users } from "../test-migrate.ts";

describe("applyMigrations building indexes concurrently", () => {
  test("lets one of two runs started together apply a migration, and the other find it done", async () => {
    const url = await postgresDatabase(
      `${users}; insert into users select i, 'u' || i from generate_series(1, 20000) i`,
    );
    const [first, second] = await Promise.all([connect(url), connect(url)]);
    try {
      const file = await migrationFrom(
        users,
        `${users}; create index users_email on users (email)`,
      );
      const results = await Promise.all([
        applyMigrations(pgConnection(first), [file]),
        applyMigrations(pgConnection(second), [file]),
      ]);
      const { rows } = await first.query<{ valid: boolean }>(
        "select indisvalid as valid from pg_index where indexrelid = 'users_email'::regclass",
      );
      expect({
        applied: results
          .map(({ applied }) => applied.length)
          .toSorted((left, right) => left - right),
        failed: results.map(({ failed }) => failed),
        rows,
      }).toStrictEqual({ applied: [0, 1], failed: [null, null], rows: [{ valid: true }] });
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  test("waits as long as it takes for a concurrent index build, which blocks no one meanwhile", async () => {
    const url = await postgresDatabase(`${users}; create table logs (id int8)`);
    const [migrator, holder, writer] = await Promise.all([
      connect(url),
      connect(url),
      connect(url),
    ]);
    try {
      await holder.query("begin isolation level repeatable read; select count(*) from logs");
      const file = await migrationFrom(
        users,
        `${users}; create index users_email on users (email)`,
      );
      const applying = applyMigrations(pgConnection(migrator), [file], {
        lockTimeout: 100,
        retries: 1,
        retryDelay: () => 0,
      });
      await sleep(500);
      const started = performance.now();
      await writer.query("insert into users values (1, 'otter@example.com')");
      const writerWaited = performance.now() - started;
      await holder.query("commit");
      expect({
        result: await applying,
        writerWaitedUnderASecond: writerWaited < 1000,
      }).toStrictEqual({
        result: { applied: [step(file.name, 0)], failed: null, waiting: null },
        writerWaitedUnderASecond: true,
      });
    } finally {
      await Promise.all([migrator.end(), holder.end(), writer.end()]);
    }
  });

  test("keeps an index a run built but did not record, and records the step", async () => {
    const url = await postgresDatabase(`${users}; create index users_email on users (email)`);
    const client = await connect(url);
    try {
      const file = await migrationFrom(
        users,
        `${users}; create index users_email on users (email)`,
      );
      const oid = async (): Promise<unknown> => {
        const { rows } = await client.query("select 'users_email'::regclass::oid as oid");
        return rows;
      };
      const before = await oid();
      const result = await applyMigrations(pgConnection(client), [file]);
      expect({
        result,
        kept: JSON.stringify(await oid()) === JSON.stringify(before),
      }).toStrictEqual({
        result: { applied: [step(file.name, 0)], failed: null, waiting: null },
        kept: true,
      });
    } finally {
      await client.end();
    }
  });

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
        resumed: { applied: [step(file.name, 0), step(file.name, 1)], failed: null, waiting: null },
        rows: [{ valid: true }],
      });
    } finally {
      await client.end();
    }
  });
});
