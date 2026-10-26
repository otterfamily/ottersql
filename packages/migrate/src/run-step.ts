import { setTimeout as sleep } from "node:timers/promises";

import type { QualifiedName } from "@ottersql/catalog";
import type { Connection, Transaction } from "@ottersql/sql";
import { rawQuery } from "@ottersql/sql/driver";

import { writeBlockingLocks } from "./plan.ts";
import type { OutsideStep, Step } from "./plan.ts";
import { qualified } from "./sql-text.ts";

export interface RunOptions {
  /**
   * How long a step in a transaction waits for a lock before giving up and retrying, in
   * milliseconds. Steps outside a transaction wait as long as they need, since their waits hold up
   * no other query.
   */
  readonly lockTimeout?: number;
  /** How many times a step that gave up waiting for a lock, or was ended by a deadlock, is retried. */
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
// A foreign key locks two tables, so it can deadlock with a transaction writing to both; Postgres
// ends one of them, and running the step again then succeeds.
const DEADLOCK_DETECTED = "40P01";
const retried: ReadonlySet<string | null> = new Set([LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED]);

export interface StepFailure {
  readonly code: string | null;
  readonly message: string;
}

/** A step to run, and what to do once it ran: inside its transaction, when it has one. */
export interface Run {
  readonly step: Step;
  /** Records the step, on the transaction the step ran in when it ran in one. */
  readonly done?: (connection: Connection | Transaction) => Promise<void>;
}

/** Runs one step, retrying while it gives up waiting for a lock or deadlocks. */
export async function runStep(
  connection: Connection,
  run: Run,
  options: RunOptions,
): Promise<StepFailure | null> {
  const settings = { ...defaults, ...options };
  return withRetries(async () => runOnce(connection, run, timeouts(run.step, settings)), settings);
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

async function runOnce(connection: Connection, run: Run, timeout: Timeouts): Promise<void> {
  const { step } = run;
  await (step.transaction === "outside"
    ? runOutside(connection, { ...run, step }, timeout)
    : runInside(connection, run, timeout));
}
/** The step and what follows it commit together, so a step is never applied without being recorded. */
async function runInside(connection: Connection, run: Run, timeout: Timeouts): Promise<void> {
  await connection.transaction(
    async (tx) => {
      for (const sql of run.step.statements) {
        await rawQuery(tx, sql, []);
      }
      await run.done?.(tx);
    },
    // Local to the transaction, as SET LOCAL is; RDS Proxy does not pin a connection for them.
    { settings: { lock_timeout: timeout.lock, statement_timeout: timeout.statement } },
  );
}

/**
 * Statements that cannot run in a transaction run one by one. An index an earlier run left invalid
 * is dropped first; one it finished but did not record is kept, and the step recorded.
 */
async function runOutside(
  connection: Connection,
  { step, done }: { readonly step: OutsideStep; readonly done?: Run["done"] },
  timeout: Timeouts,
): Promise<void> {
  await rawQuery(
    connection,
    "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
    [timeout.lock, timeout.statement],
  );
  try {
    if (await needsBuilding(connection, step)) {
      for (const sql of step.statements) {
        await rawQuery(connection, sql, []);
      }
    }
    await done?.(connection);
  } finally {
    await rawQuery(connection, "reset lock_timeout", []);
    await rawQuery(connection, "reset statement_timeout", []);
  }
}

/**
 * Whether the step must run: not when the index it builds is already valid, and only after
 * dropping the index when a failed build left it invalid.
 */
async function needsBuilding(connection: Connection, step: OutsideStep): Promise<boolean> {
  if (step.cleanup === null) {
    return true;
  }
  const left = await leftIndex(connection, step.cleanup);
  if (left === "invalid") {
    await rawQuery(
      connection,
      `DROP INDEX CONCURRENTLY ${qualified(step.cleanup.schema, step.cleanup.name)}`,
      [],
    );
  }
  return left !== "valid";
}

/** Whether `index` is missing, left invalid by a build that failed, or valid. */
async function leftIndex(
  connection: Connection,
  index: QualifiedName,
): Promise<"none" | "invalid" | "valid"> {
  const { rows } = await rawQuery(
    connection,
    `select i.indisvalid from pg_index i
      join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relname = $2`,
    [index.schema, index.name],
  );
  const [row] = rows;
  if (row === undefined) {
    return "none";
  }
  return row[0] === "t" ? "valid" : "invalid";
}

/** Retries a step that gave up waiting for a lock or was ended by a deadlock; any other error ends the run. */
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
      if (!retried.has(code) || attempt > settings.retries) {
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
