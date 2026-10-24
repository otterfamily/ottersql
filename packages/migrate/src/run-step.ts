import { setTimeout as sleep } from "node:timers/promises";

import type { Connection } from "@ottersql/sql";

import { record } from "./ledger.ts";
import type { PendingStep } from "./ledger.ts";
import { writeBlockingLocks } from "./plan.ts";
import type { Step } from "./plan.ts";

export interface RunOptions {
  /**
   * How long a step in a transaction waits for a lock before giving up and retrying, in
   * milliseconds. Steps outside a transaction wait as long as they need, since their waits hold up
   * no other query.
   */
  readonly lockTimeout?: number;
  /** How many times a step that gave up a lock is retried. */
  readonly retries?: number;
  /** Milliseconds to wait before retry `attempt`, counted from 1. */
  readonly retryDelay?: (attempt: number) => number;
  /**
   * How long a step that blocks writes may run once it has its lock, in milliseconds. Steps under
   * weaker locks, such as validating a constraint or building an index concurrently, may run as
   * long as they need.
   */
  readonly statementTimeout?: number;
}

type Settings = Required<RunOptions>;

const RETRY_DELAY_STEP = 1000;
const MAX_RETRY_DELAY = 10_000;

// A short wait for locks keeps the queries queued behind a waiting DDL statement from stalling;
// GitLab retries such migrations with a short lock_timeout in the same way.
const defaults: Settings = {
  lockTimeout: 2000,
  retries: 10,
  retryDelay: (attempt) => Math.min(attempt * RETRY_DELAY_STEP, MAX_RETRY_DELAY),
  statementTimeout: 10_000,
};

const LOCK_NOT_AVAILABLE = "55P03";

export interface StepFailure {
  readonly code: string | null;
  readonly message: string;
}

/** Runs one step and records it, retrying while it gives up waiting for a lock. */
export async function runStep(
  connection: Connection,
  pending: PendingStep,
  options: RunOptions,
): Promise<StepFailure | null> {
  const settings = { ...defaults, ...options };
  return withRetries(
    async () => runOnce(connection, pending, timeouts(pending.step, settings)),
    settings,
  );
}

interface Timeouts {
  readonly lock: string;
  readonly statement: string;
}

function timeouts(step: Step, settings: Settings): Timeouts {
  const statement = writeBlockingLocks.has(step.lock) ? settings.statementTimeout : 0;
  // A step outside a transaction, such as CREATE INDEX CONCURRENTLY, waits at its end for every
  // older transaction in the database; that wait holds up no other query, and giving it up throws
  // away the index built so far.
  const lock = step.transaction === "outside" ? 0 : settings.lockTimeout;
  return { lock: `${String(lock)}ms`, statement: `${String(statement)}ms` };
}

async function runOnce(
  connection: Connection,
  pending: PendingStep,
  timeout: Timeouts,
): Promise<void> {
  await (pending.step.transaction === "outside"
    ? runOutside(connection, pending, timeout)
    : runInside(connection, pending, timeout));
}
/** The step and its record commit together, so a step is never applied without being recorded. */
async function runInside(
  connection: Connection,
  pending: PendingStep,
  timeout: Timeouts,
): Promise<void> {
  await connection.query("begin", []);
  try {
    // Like SET LOCAL, set_config(..., true) ends with the transaction, and RDS Proxy does not pin
    // a connection for it.
    await connection.query(
      "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
      [timeout.lock, timeout.statement],
    );
    for (const sql of pending.step.statements) {
      await connection.query(sql, []);
    }
    await record(connection, pending);
    await connection.query("commit", []);
  } catch (error) {
    await connection.query("rollback", []);
    throw error;
  }
}

/** Statements that cannot run in a transaction run one by one, after clearing a failed earlier run. */
async function runOutside(
  connection: Connection,
  pending: PendingStep,
  timeout: Timeouts,
): Promise<void> {
  await connection.query(
    "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
    [timeout.lock, timeout.statement],
  );
  try {
    for (const sql of [...pending.step.cleanup, ...pending.step.statements]) {
      await connection.query(sql, []);
    }
    await record(connection, pending);
  } finally {
    await connection.query("reset lock_timeout", []);
    await connection.query("reset statement_timeout", []);
  }
}

/** Retries a step that gave up waiting for a lock; any other error ends the run. */
async function withRetries(
  run: () => Promise<void>,
  settings: Settings,
): Promise<StepFailure | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run();
      return null;
    } catch (error) {
      const code = sqlState(error);
      if (code !== LOCK_NOT_AVAILABLE || attempt > settings.retries) {
        return { code, message: error instanceof Error ? error.message : String(error) };
      }
      await sleep(settings.retryDelay(attempt));
    }
  }
}

function sqlState(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}
