// Plays the migrations in db/migrations against the Postgres of `pnpm db:up`, one at a time, with
// the failures production migrations run into. Usage: pnpm db:up && pnpm scenario
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  applyMigrations,
  ApprovalRequiredError,
  MigrationHistoryError,
  pendingChanges,
} from "ottersql/migrate";
import type { ApplyOptions, ApplyResult, MigrationFile } from "ottersql/migrate";
import { pgConnection } from "ottersql/pg";
import { Client } from "pg";

import { databaseUrl, readMigrations, schemaFile } from "./files.ts";

const files = await readMigrations();
const clients = await Promise.all([connect(), connect(), connect()]);
const [migrator, holder, reader] = clients;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

/** Applies the migrations up to the one whose name starts with `last`, as if the later ones were not written yet. */
async function applyThrough(last: string, options: ApplyOptions = {}): Promise<ApplyResult> {
  const through = files.filter((file) => file.name <= `${last}~`);
  const result = await applyMigrations(pgConnection(migrator), through, options);
  const applied = result.applied.map(({ migration, step }) => `${migration} step ${String(step)}`);
  console.log(`  applied: ${applied.length > 0 ? applied.join(", ") : "nothing"}`);
  if (result.failed !== null) {
    const { migration, step, code, message } = result.failed;
    console.log(
      `  FAILED at ${migration} step ${String(step)} (SQLSTATE ${String(code)}): ${message}`,
    );
  }
  return result;
}

async function run(sql: string): Promise<void> {
  console.log(`  > ${sql}`);
  await migrator.query(sql);
}

async function startOver(): Promise<void> {
  await migrator.query("drop schema if exists ottersql cascade; drop schema public cascade");
  await migrator.query("create schema public");
}

async function createTables(): Promise<void> {
  console.log(
    "\n1. Create users and posts, and add users, one without an email and two sharing one",
  );
  await applyThrough("20261026090000");
  await run(
    "insert into users (email, name) values (null, 'Otter'), ('seal@example.com', 'Seal'), ('seal@example.com', 'Seal again')",
  );
}

async function requireEmail(): Promise<void> {
  console.log("\n2. Require an email: validating existing rows fails on the user without one");
  await applyThrough("20261026100000");
  await run("update users set email = 'otter@example.com' where email is null");
  console.log("  Applied again, it resumes at the step that failed:");
  await applyThrough("20261026100000");
}

async function uniqueEmail(): Promise<void> {
  console.log("\n3. Make emails unique: building the index concurrently fails on the duplicate");
  await applyThrough("20261026110000");
  const { rows } = await migrator.query<{ valid: boolean }>(
    "select indisvalid as valid from pg_index where indexrelid = 'users_email_key'::regclass",
  );
  console.log(`  The failed build left the index behind, valid: ${String(rows[0]?.valid)}`);
  await run("delete from users where name = 'Seal again'");
  console.log("  Applied again, it drops the invalid index and builds it anew:");
  await applyThrough("20261026110000");
}

const LOCK_TIMEOUT = 300;
const RETRY_DELAY = 200;
const READER_STARTS_AFTER = 500;
const TRANSACTION_ENDS_AFTER = 1000;

async function timedRead(): Promise<number> {
  const started = performance.now();
  await reader.query("select count(*) from posts");
  return Math.round(performance.now() - started);
}

async function waitForLock(): Promise<void> {
  console.log("\n4. Add post status while a long transaction reads posts");
  await holder.query("begin; select * from posts");
  const applying = applyThrough("20261026120000", {
    lockTimeout: LOCK_TIMEOUT,
    retries: 20,
    retryDelay: () => RETRY_DELAY,
  });
  await sleep(READER_STARTS_AFTER);
  const waited = await timedRead();
  console.log(
    `  Meanwhile a query on posts waited ${String(waited)} ms: the migration gives up the lock it waits for every ${String(LOCK_TIMEOUT)} ms instead of holding everyone behind it`,
  );
  await sleep(TRANSACTION_ENDS_AFTER);
  await holder.query("commit");
  console.log("  The long transaction committed; the migration gets its lock on a retry:");
  await applying;
}

async function archivePosts(): Promise<void> {
  console.log(
    "\n5. Archive posts: an enum value cannot be removed once added, so it waits for approval",
  );
  try {
    await applyThrough("20261026130000");
  } catch (error) {
    if (!(error instanceof ApprovalRequiredError)) {
      throw error;
    }
    for (const { migration, step, kind, object } of error.steps) {
      console.log(`  Needs approval: ${migration} step ${String(step)}, ${kind} ${object}`);
    }
    console.log("  Approved after review, the same pending steps run:");
    await applyThrough("20261026130000", { approve: error.approval });
  }
}

async function refuse(title: string, changed: readonly MigrationFile[]): Promise<void> {
  console.log(`\n${title}`);
  try {
    await applyMigrations(pgConnection(migrator), changed);
  } catch (error) {
    if (!(error instanceof MigrationHistoryError)) {
      throw error;
    }
    console.log(`  Refused before running anything: ${error.message}`);
  }
}

async function check(): Promise<void> {
  console.log("\n7. Check that the migrations build db/schema.sql");
  const plan = await pendingChanges(files, await readFile(schemaFile, "utf8"));
  console.log(
    plan.steps.length === 0 && plan.manual.length === 0
      ? "  They do: replayed in PGlite, they leave exactly the schema db/schema.sql describes."
      : `  They do not: ${String(plan.steps.length)} steps are missing; run pnpm generate.`,
  );
}

try {
  await startOver();
  await createTables();
  await requireEmail();
  await uniqueEmail();
  await waitForLock();
  await archivePosts();
  const last = files.at(-1);
  if (last !== undefined) {
    await refuse("6a. A migration edited after it was applied", [
      ...files.slice(0, -1),
      { name: last.name, text: last.text.replace("'archived'", "'hidden'") },
    ]);
  }
  await refuse("6b. A new migration older than ones already applied", [
    ...files,
    { name: "20261026000000_late.sql", text: files.at(0)?.text ?? "" },
  ]);
  await check();
} finally {
  await Promise.all(clients.map(async (client) => client.end()));
}
