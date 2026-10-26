import { setTimeout as sleep } from "node:timers/promises";

import { rawQuery } from "../sql/driver.ts";
import type { Connection, Transaction } from "../sql/index.ts";
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
 * The connection moved to another database session while a run held the ledger's lock, as a pool
 * or a pooler in transaction mode does, so the lock no longer kept other runs out. The lock stays
 * with the first session until that session ends.
 */
export class SessionChangedError extends Error {
  override readonly name = "SessionChangedError";

  constructor() {
    super(
      "The connection moved to another database session while it held the migration lock; migrations need one session for the whole run",
    );
  }
}

/**
 * Runs `use` while holding the session's advisory lock on the ledger, so that runs started
 * together apply each step once: the second waits, then reads what the first recorded. It throws
 * a `SessionChangedError`, before `use` runs where it can tell, when the connection does not keep
 * one session; an error from `use` is thrown as it was.
 */
export async function exclusively<Result>(
  connection: Connection,
  use: () => Promise<Result>,
): Promise<Result> {
  const session = await lock(connection);
  const result = await unlockingOnError(connection, session, async () => {
    await expectSession(connection, session);
    return use();
  });
  if (!(await unlock(connection, session))) {
    throw new SessionChangedError();
  }
  return result;
}

/** Runs `run`, giving the lock up before throwing what it throws. */
async function unlockingOnError<Result>(
  connection: Connection,
  session: string,
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    try {
      await unlock(connection, session);
    } catch {
      // The error from run says better what went wrong.
    }
    throw error;
  }
}

/** Takes the lock, and returns the backend pid of the session that holds it. */
async function lock(connection: Connection): Promise<string> {
  // Not pg_advisory_lock: waiting in it keeps a statement open, and CREATE INDEX CONCURRENTLY in
  // the run that holds the lock waits for every open statement to end, so the two would deadlock.
  for (;;) {
    const { rows } = await rawQuery(
      connection,
      "select pg_try_advisory_lock(hashtextextended($1, 0)), pg_backend_pid()",
      [LOCK_NAME],
    );
    const [taken, session] = rows[0] ?? [];
    if (taken === "t" && session !== undefined && session !== null) {
      return session;
    }
    await sleep(LOCK_POLL_INTERVAL);
  }
}

async function expectSession(connection: Connection, session: string): Promise<void> {
  const { rows } = await rawQuery(connection, "select pg_backend_pid()", []);
  if (rows[0]?.[0] !== session) {
    throw new SessionChangedError();
  }
}

/** Gives the lock up if the connection is still on `session`, and says whether it did. */
async function unlock(connection: Connection, session: string): Promise<boolean> {
  // Only from the session that took it: another session's unlock could free a lock held by a
  // different run that shares the pooler's backend. CASE, not AND, which may run either side first.
  const { rows } = await rawQuery(
    connection,
    `select case when pg_backend_pid() = $2::int4
       then pg_advisory_unlock(hashtextextended($1, 0)) else false end`,
    [LOCK_NAME, session],
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
