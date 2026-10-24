import { loadCatalog } from "@ottersql/catalog";
import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { planMigration } from "./index.ts";
import type { Step } from "./index.ts";
import { writeBlockingLocks } from "./plan.ts";

/** Rows enough to tell a scan from none: reads are counted, not timed, so the size does not matter. */
const ROWS = 1000;

const users = `create table users (id int8 primary key, email text, nickname text default 'otter');
  insert into users select i, 'u' || i || '@example.com' from generate_series(1, ${String(ROWS)}) i`;
const orders = `create table orders (id int8 primary key, user_id int8, total int4);
  insert into orders select i, i, i from generate_series(1, ${String(ROWS)}) i`;

interface TableState {
  readonly reads: number;
  readonly file: string;
}

/** Rows each table has had read by sequential scans, and the file it is stored in, by table. */
async function tableStates(client: Client): Promise<Map<string, TableState>> {
  // Statistics reach the views at the next flush, so one is forced after the step ran.
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_clear_snapshot()");
  const { rows } = await client.query<{ name: string; reads: string; file: string }>(
    `select s.relname as name, s.seq_tup_read as reads, c.relfilenode::text as file
    from pg_stat_user_tables s join pg_class c on c.oid = s.relid`,
  );
  return new Map(rows.map(({ name, reads, file }) => [name, { reads: Number(reads), file }]));
}

async function runStep(client: Client, step: Step): Promise<void> {
  if (step.transaction === "outside") {
    for (const sql of step.statements) {
      await client.query(sql);
    }
    return;
  }
  await client.query("begin");
  for (const sql of step.statements) {
    await client.query(sql);
  }
  await client.query("commit");
}

/** How `step` scanned or rewrote a table while blocking writes, by the table states around it. */
function blockingWorkOf(
  step: Step,
  before: ReadonlyMap<string, TableState>,
  after: ReadonlyMap<string, TableState>,
): string[] {
  if (!writeBlockingLocks.has(step.lock)) {
    return [];
  }
  return [...before].flatMap(([table, was]) => {
    const now = after.get(table) ?? was;
    const read = now.reads - was.reads;
    return [
      read > 0 ? `${step.kind} ${step.object} read ${String(read)} rows of ${table}` : null,
      now.file === was.file ? null : `${step.kind} ${step.object} rewrote ${table}`,
    ].filter((line) => line !== null);
  });
}

/** What each step that blocks writes did to a table it should leave alone: scan or rewrite it. */
async function blockingWork(fromSql: string, steps: readonly Step[]): Promise<string[]> {
  const client = new Client({ connectionString: await postgresDatabase(fromSql) });
  await client.connect();
  try {
    const found: string[] = [];
    for (const step of steps) {
      const before = await tableStates(client);
      await runStep(client, step);
      found.push(...blockingWorkOf(step, before, await tableStates(client)));
    }
    return found;
  } finally {
    await client.end();
  }
}

describe("steps that block writes", () => {
  test.for([
    {
      change: "adding columns, a NOT NULL, a default and dropping one",
      from: users,
      to: "create table users (id int8 primary key, email text not null, nickname text, active bool not null default true, note text)",
    },
    {
      change: "adding a foreign key, a check and a unique key",
      from: `${users}; ${orders}`,
      to: `create table users (id int8 primary key, email text unique, nickname text default 'otter');
        create table orders (id int8 primary key, user_id int8 references users, total int4 check (total >= 0))`,
    },
    {
      change: "adding a primary key",
      from: "create table logs (id int8 not null, body text); insert into logs select i, 'x' from generate_series(1, 1000) i",
      to: "create table logs (id int8 primary key, body text)",
    },
    {
      change: "dropping a column, constraints, an index and a table",
      from: `${users}; ${orders}; alter table orders add foreign key (user_id) references users;
        alter table orders add check (total >= 0); create index orders_total on orders (total)`,
      to: "create table users (id int8 primary key, nickname text default 'otter')",
    },
    {
      change: "adding an enum value and an index",
      from: `create type status as enum ('new'); ${orders}; alter table orders add column status status`,
      to: `create type status as enum ('new', 'paid');
        create table orders (id int8 primary key, user_id int8, total int4, status status);
        create index orders_user on orders (user_id)`,
    },
  ])("neither scan nor rewrite a table when $change", { timeout: 60_000 }, async ({ from, to }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect({
      planned: plan.steps.length > 0,
      found: await blockingWork(from, plan.steps),
    }).toStrictEqual({ planned: true, found: [] });
  });

  test("are caught when they scan, as SET NOT NULL without a valid check does", async () => {
    const naive: Step = {
      kind: "setNotNull",
      object: "public.users.email",
      statements: ["ALTER TABLE users ALTER COLUMN email SET NOT NULL"],
      phase: "contract",
      reversal: "reversible",
      transaction: "inside",
      cleanup: [],
      lock: "access exclusive",
      reason: null,
    };
    await expect(blockingWork(users, [naive])).resolves.toStrictEqual([
      `setNotNull public.users.email read ${String(ROWS)} rows of users`,
    ]);
  }, 60_000);
});
