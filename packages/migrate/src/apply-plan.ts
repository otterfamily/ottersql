import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { Connection } from "@ottersql/sql";

import type { Lock, Plan, Step } from "./plan.ts";

export interface ApplyOptions {
  /** How long a step waits for a lock before giving up and retrying, in milliseconds. */
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

export interface ApplyResult {
  /** Indexes into `plan.steps`. */
  readonly applied: readonly number[];
  /** Steps an earlier run of the same plan applied. */
  readonly skipped: readonly number[];
  /** The step that failed, with Postgres's SQLSTATE; the steps after it did not run. */
  readonly failed: {
    readonly step: number;
    readonly code: string | null;
    readonly message: string;
  } | null;
}

const RETRY_DELAY_STEP = 1000;
const MAX_RETRY_DELAY = 10_000;

// A short wait for locks keeps the queries queued behind a waiting DDL statement from stalling;
// GitLab retries such migrations with a short lock_timeout in the same way.
const defaults: Required<ApplyOptions> = {
  lockTimeout: 2000,
  retries: 10,
  retryDelay: (attempt) => Math.min(attempt * RETRY_DELAY_STEP, MAX_RETRY_DELAY),
  statementTimeout: 10_000,
};

const LOCK_NOT_AVAILABLE = "55P03";
const writeBlocking: ReadonlySet<Lock> = new Set(["access exclusive", "share row exclusive"]);

const ledger = "ottersql.applied_steps";

/**
 * Applies `plan` on `connection`, which must be one session (a `pg` Client or PoolClient, or
 * PGlite), so that a transaction's statements share it. Each applied step is recorded in the
 * database, so running the same plan again resumes after the last step that succeeded.
 */
export async function applyPlan(
  connection: Connection,
  plan: Plan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const settings = { ...defaults, ...options };
  const id = planId(plan);
  const done = await appliedSteps(connection, id);
  const skipped = [...done].toSorted((left, right) => left - right);
  const pending = plan.steps.flatMap((step, index) =>
    done.has(index) ? [] : [{ id, index, step }],
  );
  return { ...(await runInOrder(connection, pending, settings)), skipped };
}

/** Runs steps until one fails. */
async function runInOrder(
  connection: Connection,
  pending: readonly Planned[],
  settings: Required<ApplyOptions>,
): Promise<Pick<ApplyResult, "applied" | "failed">> {
  const applied: number[] = [];
  for (const planned of pending) {
    const failure = await withRetries(async () => runStep(connection, planned, settings), settings);
    if (failure !== null) {
      return { applied, failed: { step: planned.index, ...failure } };
    }
    applied.push(planned.index);
  }
  return { applied, failed: null };
}

function planId(plan: Plan): string {
  return createHash("sha256").update(JSON.stringify(plan.steps)).digest("hex");
}

async function appliedSteps(connection: Connection, id: string): Promise<ReadonlySet<number>> {
  await connection.query("create schema if not exists ottersql", []);
  await connection.query(
    `create table if not exists ${ledger} (
      plan text not null, step int4 not null, kind text not null, object text not null,
      applied_at timestamptz not null default now(), primary key (plan, step)
    )`,
    [],
  );
  const { rows } = await connection.query(`select step from ${ledger} where plan = $1`, [id]);
  return new Set(rows.map(([step]) => Number(step)));
}

interface Planned {
  readonly id: string;
  readonly index: number;
  readonly step: Step;
}

async function record(connection: Connection, { id, index, step }: Planned): Promise<void> {
  await connection.query(
    `insert into ${ledger} (plan, step, kind, object) values ($1, $2, $3, $4)`,
    [id, String(index), step.kind, step.object],
  );
}

function timeouts(step: Step, settings: Required<ApplyOptions>): readonly [string, string] {
  const statement = writeBlocking.has(step.lock) ? settings.statementTimeout : 0;
  return [`${String(settings.lockTimeout)}ms`, `${String(statement)}ms`];
}

async function runStep(
  connection: Connection,
  planned: Planned,
  settings: Required<ApplyOptions>,
): Promise<void> {
  const [lock, statement] = timeouts(planned.step, settings);
  await (planned.step.transaction === "outside"
    ? runOutside(connection, planned, { lock, statement })
    : runInside(connection, planned, { lock, statement }));
}

/** The step and its record commit together, so a step is never applied without being recorded. */
async function runInside(
  connection: Connection,
  planned: Planned,
  timeout: { readonly lock: string; readonly statement: string },
): Promise<void> {
  await connection.query("begin", []);
  try {
    // Like SET LOCAL, set_config(..., true) ends with the transaction, and RDS Proxy does not pin
    // a connection for it.
    await connection.query(
      "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
      [timeout.lock, timeout.statement],
    );
    for (const sql of planned.step.statements) {
      await connection.query(sql, []);
    }
    await record(connection, planned);
    await connection.query("commit", []);
  } catch (error) {
    await connection.query("rollback", []);
    throw error;
  }
}

/** Statements that cannot run in a transaction run one by one, after clearing a failed earlier run. */
async function runOutside(
  connection: Connection,
  planned: Planned,
  timeout: { readonly lock: string; readonly statement: string },
): Promise<void> {
  await connection.query(
    "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
    [timeout.lock, timeout.statement],
  );
  try {
    for (const sql of [...planned.step.cleanup, ...planned.step.statements]) {
      await connection.query(sql, []);
    }
    await record(connection, planned);
  } finally {
    await connection.query("reset lock_timeout", []);
    await connection.query("reset statement_timeout", []);
  }
}

/** Retries a step that gave up waiting for a lock; any other error ends the run. */
async function withRetries(
  run: () => Promise<void>,
  settings: Required<ApplyOptions>,
): Promise<{ readonly code: string | null; readonly message: string } | null> {
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
