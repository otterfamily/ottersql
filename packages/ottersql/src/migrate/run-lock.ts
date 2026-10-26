import { setTimeout as sleep } from "node:timers/promises";

import { rawQuery } from "../sql/driver.ts";
import type { Connection } from "../sql/index.ts";
import { SessionChangedError } from "./session-changed-error.ts";

// One name for every run on a database, hashed to the bigint key advisory locks take.
const LOCK_NAME = "ottersql.applied_steps";
const LOCK_POLL_INTERVAL = 200;
// The sessions holding the lock: an advisory lock on a bigint key shows in pg_locks split into
// classid (its high 32 bits) and objid.
const LOCK_HOLDERS = `select pid from pg_locks
  where locktype = 'advisory' and objsubid = 1 and granted
    and (classid::int8 << 32 | objid::int8) = hashtextextended($1, 0)`;
/** How long a run waits for another that holds the lock, by default: 10 minutes. */
export const DEFAULT_LOCK_WAIT = 600_000;

/**
 * Another run held the ledger's lock for longer than this run would wait. `holder` is the backend
 * pid of the session holding it, or `null` when it let go as the wait ended.
 */
export class LockWaitTimeoutError extends Error {
  override readonly name = "LockWaitTimeoutError";
  readonly holder: number | null;

  constructor(holder: number | null, waited: number) {
    super(
      `Another run held the migration lock${holder === null ? "" : ` in backend pid ${String(holder)}`} for over ${String(waited)} ms`,
    );
    this.holder = holder;
  }
}

/**
 * Runs `use` while holding the session's advisory lock on the ledger, so that runs started
 * together apply each step once: the second waits, then reads what the first recorded. It throws
 * a `LockWaitTimeoutError` when another run holds the lock for longer than `wait` milliseconds, and
 * a `SessionChangedError`, before `use` runs where it can tell, when the connection does not keep
 * one session; an error from `use` is thrown as it was. `wait` is a finite number from 0.
 */
export async function exclusively<Result>(
  connection: Connection,
  use: () => Promise<Result>,
  wait: number = DEFAULT_LOCK_WAIT,
): Promise<Result> {
  if (!Number.isFinite(wait) || wait < 0) {
    throw new RangeError(`The wait for another run is milliseconds from 0, not ${String(wait)}`);
  }
  const session = await lock(connection, wait);
  const result = await unlockingOnError(connection, session, async () => {
    await expectSession(connection, session);
    return use();
  });
  if (!(await unlock(connection, session))) {
    throw new SessionChangedError(true);
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

/** Takes the lock within `wait` milliseconds, and returns the backend pid of the session that holds it. */
async function lock(connection: Connection, wait: number): Promise<string> {
  const deadline = performance.now() + wait;
  // Not pg_advisory_lock: waiting in it keeps a statement open, and CREATE INDEX CONCURRENTLY in
  // the run that holds the lock waits for every open statement to end, so the two would deadlock.
  for (;;) {
    // A session takes an advisory lock it holds again, so one a pooler gives two runs would let
    // both in; it counts as taken by another run. CASE, not AND, which may run either side first.
    const { rows } = await rawQuery(
      connection,
      `select case when pg_backend_pid() in (${LOCK_HOLDERS}) then false
         else pg_try_advisory_lock(hashtextextended($1, 0)) end,
       pg_backend_pid()`,
      [LOCK_NAME],
    );
    const [taken, session] = rows[0] ?? [];
    if (taken === "t" && session !== undefined && session !== null) {
      return session;
    }
    if (performance.now() >= deadline) {
      throw new LockWaitTimeoutError(await lockHolder(connection), wait);
    }
    await sleep(LOCK_POLL_INTERVAL);
  }
}

/** The backend pid of the session holding the lock, or `null` when none does. */
async function lockHolder(connection: Connection): Promise<number | null> {
  const { rows } = await rawQuery(connection, LOCK_HOLDERS, [LOCK_NAME]);
  const pid = rows[0]?.[0];
  return pid === undefined || pid === null ? null : Number(pid);
}

async function expectSession(connection: Connection, session: string): Promise<void> {
  const { rows } = await rawQuery(connection, "select pg_backend_pid()", []);
  if (rows[0]?.[0] !== session) {
    throw new SessionChangedError(false);
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
