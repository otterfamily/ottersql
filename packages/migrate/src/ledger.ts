import type { Connection } from "@ottersql/sql";

import type { Step } from "./plan.ts";

// The catalog leaves the ottersql schema out, so migrations never plan changes to this table.
const ledger = "ottersql.applied_steps";

/** A step that ran, with the hash of its file at the time. */
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

export async function readLedger(connection: Connection): Promise<AppliedStep[]> {
  await connection.query("create schema if not exists ottersql", []);
  await connection.query(
    `create table if not exists ${ledger} (
      migration text not null, step int4 not null, hash text not null, kind text not null,
      object text not null, applied_at timestamptz not null default now(),
      primary key (migration, step)
    )`,
    [],
  );
  const { rows } = await connection.query(`select migration, step, hash from ${ledger}`, []);
  return rows.map(([migration, step, hash]) => ({
    migration: migration ?? "",
    step: Number(step),
    hash: hash ?? "",
  }));
}

export async function record(connection: Connection, pending: PendingStep): Promise<void> {
  await connection.query(
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
