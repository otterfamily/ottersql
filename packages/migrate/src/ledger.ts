import { setTimeout as sleep } from "node:timers/promises";

import type { Connection, Transaction } from "@ottersql/sql";
import { rawQuery } from "@ottersql/sql/driver";

import type { Step } from "./plan.ts";

// The catalog leaves the ottersql schema out, so migrations never plan changes to this table.
const ledger = "ottersql.applied_steps";

/** A step that ran, with the hash of what it did. */
export interface AppliedStep {
  readonly migration: string;
  readonly step: number;
  readonly hash: string;
}

/** A step to run, with what its record needs. */
export interface PendingStep {
  readonly migration: string;
  readonly hash: string;
  readonly index: number;
  readonly step: Step;
}

// One name for every run on a database, hashed to the bigint key advisory locks take.
const LOCK_NAME = "ottersql.applied_steps";
const LOCK_POLL_INTERVAL = 200;

/**
 * Runs `use` while holding the session's advisory lock on the ledger, so that runs started
 * together apply each step once: the second waits, then reads what the first recorded.
 */
export async function exclusively<Result>(
  connection: Connection,
  use: () => Promise<Result>,
): Promise<Result> {
  // Not pg_advisory_lock: waiting in it keeps a statement open, and CREATE INDEX CONCURRENTLY in
  // the run that holds the lock waits for every open statement to end, so the two would deadlock.
  while (!(await tryLock(connection))) {
    await sleep(LOCK_POLL_INTERVAL);
  }
  try {
    return await use();
  } finally {
    await rawQuery(connection, "select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]);
  }
}

async function tryLock(connection: Connection): Promise<boolean> {
  const { rows } = await rawQuery(
    connection,
    "select pg_try_advisory_lock(hashtextextended($1, 0))",
    [LOCK_NAME],
  );
  return rows[0]?.[0] === "t";
}

export async function createLedger(connection: Connection): Promise<void> {
  await rawQuery(connection, "create schema if not exists ottersql", []);
  await rawQuery(
    connection,
    `create table if not exists ${ledger} (
      migration text not null, step int4 not null, hash text not null, kind text not null,
      object text not null, applied_at timestamptz not null default now(),
      primary key (migration, step)
    )`,
    [],
  );
}

/** The steps that ran, or none when the database never ran any; it writes nothing. */
export async function readLedger(connection: Connection): Promise<AppliedStep[]> {
  const exists = await rawQuery(connection, `select to_regclass('${ledger}') is not null`, []);
  if (exists.rows[0]?.[0] !== "t") {
    return [];
  }
  const { rows } = await rawQuery(connection, `select migration, step, hash from ${ledger}`, []);
  return rows.map(([migration, step, hash]) => ({
    migration: migration ?? "",
    step: Number(step),
    hash: hash ?? "",
  }));
}

export async function record(
  connection: Connection | Transaction,
  pending: PendingStep,
): Promise<void> {
  await rawQuery(
    connection,
    `insert into ${ledger} (migration, step, hash, kind, object) values ($1, $2, $3, $4, $5)`,
    [
      pending.migration,
      String(pending.index),
      pending.hash,
      pending.step.kind,
      pending.step.object,
    ],
  );
}

/** Records `steps` as applied without running them, all of them or, when one fails, none. */
export async function recordAll(
  connection: Connection,
  steps: readonly PendingStep[],
): Promise<void> {
  await createLedger(connection);
  await connection.transaction(async (tx) => {
    for (const step of steps) {
      await record(tx, step);
    }
  });
}
