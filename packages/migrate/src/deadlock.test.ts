import { setTimeout as sleep } from "node:timers/promises";

import { pgConnection } from "@ottersql/sql/pg";
import { postgresDatabase } from "@ottersql/testing";
import type { Client } from "pg";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "./index.ts";
import { connect, migrationFrom, step, users } from "./test-migrate.ts";

const posts = "create table posts (id int8 primary key, author_id int8)";
const POLL_INTERVAL = 20;

/** Waits until `waiter`'s session is blocked on a lock, as `observer` sees it. */
async function waitForLock(observer: Client, waiter: Client): Promise<void> {
  const {
    rows: [session],
  } = await waiter.query<{ pid: number }>("select pg_backend_pid() as pid");
  for (;;) {
    const { rows } = await observer.query<{ waiting: boolean }>(
      "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
      [session?.pid],
    );
    if (rows[0]?.waiting === true) {
      return;
    }
    await sleep(POLL_INTERVAL);
  }
}

describe("applyMigrations on Postgres", () => {
  test("retries a step that Postgres ended to break a deadlock", async () => {
    const url = await postgresDatabase(`${users}; ${posts}`);
    const [migrator, writer] = await Promise.all([connect(url), connect(url)]);
    try {
      // The migrator notices the deadlock long before the writer, so it is the one Postgres ends.
      await migrator.query("set deadlock_timeout = '100ms'");
      await writer.query("set deadlock_timeout = '10s'");
      const file = await migrationFrom(
        `${users}; ${posts}`,
        `${users}; create table posts (id int8 primary key, author_id int8 references users)`,
      );
      await writer.query("begin; insert into users values (1, 'otter@example.com')");
      const applying = applyMigrations(pgConnection(migrator), [file], {
        lockTimeout: 5000,
        retryDelay: () => 100,
      });
      // Adding the foreign key locks posts, then waits for users; the writer now waits for posts.
      await waitForLock(writer, migrator);
      await writer.query("insert into posts values (1, 1)");
      await writer.query("commit");
      await expect(applying).resolves.toStrictEqual({
        applied: [step(file.name, 0), step(file.name, 1)],
        failed: null,
        waiting: null,
      });
    } finally {
      await Promise.all([migrator.end(), writer.end()]);
    }
  }, 30_000);
});
