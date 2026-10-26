import type { CatalogOptions } from "../catalog/index.ts";
import { rawQuery } from "../sql/driver.ts";
import type { Connection, Transaction } from "../sql/index.ts";
import type { Step } from "./plan.ts";

const LEDGER_SCHEMA = "ottersql";
const ledger = `${LEDGER_SCHEMA}.applied_steps`;

/**
 * What migrations read of a database's catalog: everything but the ledger's schema, so they never
 * plan changes to the record of what they did.
 */
export const migratedObjects: CatalogOptions = { omitSchemas: [LEDGER_SCHEMA] };

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

export async function createLedger(connection: Connection): Promise<void> {
  await rawQuery(connection, `create schema if not exists ${LEDGER_SCHEMA}`, []);
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
