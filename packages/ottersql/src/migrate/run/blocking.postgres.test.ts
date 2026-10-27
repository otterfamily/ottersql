import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { loadCatalog } from "../../catalog/index.ts";
import { planMigration } from "../index.ts";
import type { Step } from "../index.ts";
import { writeBlockingLocks } from "../plan.ts";

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

/**
 * Rows each table has had read by sequential scans, and the file it is stored in, by table; and
 * the file of each index, which a rebuild replaces.
 */
async function tableStates(client: Client): Promise<Map<string, TableState>> {
  // Statistics reach the views at the next flush, so one is forced after the step ran.
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_clear_snapshot()");
  const { rows } = await client.query<{ name: string; reads: string; file: string }>(
    `select s.relname as name, s.seq_tup_read as reads, c.relfilenode::text as file
    from pg_stat_user_tables s join pg_class c on c.oid = s.relid
    union all
    select s.indexrelname, 0, c.relfilenode::text
    from pg_stat_user_indexes s join pg_class c on c.oid = s.indexrelid`,
  );
  return new Map(rows.map(({ name, reads, file }) => [name, { reads: Number(reads), file }]));
}

/** A lock a step held on a table, by its pg_locks mode. */
interface TakenLock {
  readonly name: string;
  readonly mode: string;
}

/** Postgres's table lock modes, weakest first. */
const lockModes = [
  "AccessShareLock",
  "RowShareLock",
  "RowExclusiveLock",
  "ShareUpdateExclusiveLock",
  "ShareLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
];

/** The strongest mode each declared lock allows; "none" still reads, as every statement does. */
const allowedModes: Readonly<Record<Step["lock"], string>> = {
  none: "AccessShareLock",
  "row exclusive": "RowExclusiveLock",
  "share update exclusive": "ShareUpdateExclusiveLock",
  "share row exclusive": "ShareRowExclusiveLock",
  "access exclusive": "AccessExclusiveLock",
};

/**
 * Runs `step`, and returns the locks it held before committing on the tables that existed before
 * it. A step outside a transaction leaves nothing to read in pg_locks; the planner gives such steps
 * only CREATE and DROP INDEX CONCURRENTLY, whose lock Postgres fixes.
 */
async function runStep(client: Client, step: Step): Promise<TakenLock[]> {
  if (step.transaction === "outside") {
    for (const sql of step.statements) {
      await client.query(sql);
    }
    return [];
  }
  const existing = await client.query<{ oid: string }>(
    "select oid::text from pg_class where relkind in ('r', 'p') and relnamespace = 'public'::regnamespace",
  );
  await client.query("begin");
  for (const sql of step.statements) {
    await client.query(sql);
  }
  const { rows } = await client.query<TakenLock>(
    `select c.relname as name, l.mode from pg_locks l join pg_class c on c.oid = l.relation
    where l.pid = pg_backend_pid() and l.locktype = 'relation' and c.oid = any($1::oid[])`,
    [existing.rows.map(({ oid }) => oid)],
  );
  await client.query("commit");
  return rows;
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

/** The locks `step` took that are stronger than the one it declares. */
function understatedLocks(step: Step, taken: readonly TakenLock[]): string[] {
  const allowed = lockModes.indexOf(allowedModes[step.lock]);
  return taken
    .filter(({ mode }) => lockModes.indexOf(mode) > allowed)
    .map(({ name, mode }) => `${step.kind} ${step.object} took ${mode} on ${name}`);
}

/**
 * What each step did that its plan does not allow: scan or rewrite a table while blocking writes,
 * or lock a table harder than it declares.
 */
async function overreach(fromSql: string, steps: readonly Step[]): Promise<string[]> {
  const client = new Client({ connectionString: await postgresDatabase(fromSql) });
  await client.connect();
  try {
    const found: string[] = [];
    for (const step of steps) {
      const before = await tableStates(client);
      const taken = await runStep(client, step);
      found.push(
        ...blockingWorkOf(step, before, await tableStates(client)),
        ...understatedLocks(step, taken),
      );
    }
    return found;
  } finally {
    await client.end();
  }
}

/** A step written as a person might, to check that `overreach` sees what it is meant to. */
function naive(spec: Pick<Step, "kind" | "object" | "statements" | "lock">): Step {
  return {
    ...spec,
    phase: "contract",
    reversal: "reversible",
    transaction: "inside",
    reason: null,
  };
}

describe("steps", () => {
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
      change: "widening and narrowing unique keys",
      from: `create table accounts (id int8 primary key, email text, tenant int8, code text, unique (email), unique (code, tenant));
        insert into accounts select i, 'a' || i, i, 'c' || i from generate_series(1, 1000) i`,
      to: "create table accounts (id int8 primary key, email text, tenant int8, code text, unique (email, tenant), unique (code))",
    },
    {
      change: "adding an enum value and an index",
      from: `create type status as enum ('new'); ${orders}; alter table orders add column status status`,
      to: `create type status as enum ('new', 'paid');
        create table orders (id int8 primary key, user_id int8, total int4, status status);
        create index orders_user on orders (user_id)`,
    },
    {
      change: "replacing a changed check and a changed foreign key",
      from: `${users}; ${orders}; alter table orders add constraint orders_user foreign key (user_id) references users;
        alter table orders add constraint orders_total check (total >= 0)`,
      to: `create table users (id int8 primary key, email text, nickname text default 'otter');
        create table orders (id int8 primary key, user_id int8, total int4);
        alter table orders add constraint orders_user foreign key (user_id) references users on delete cascade;
        alter table orders add constraint orders_total check (total > 0)`,
    },
    {
      change: "widening varchar columns that an index covers",
      from: `create table names (id int8 primary key, short varchar(20) unique, long varchar(50));
        create index names_long on names (long);
        insert into names select i, 's' || i, 'l' || i from generate_series(1, 1000) i`,
      to: `create table names (id int8 primary key, short varchar(40) unique, long text);
        create index names_long on names (long)`,
    },
  ])(
    "neither scan nor rewrite a table while blocking writes, nor lock harder than they say, when $change",
    { timeout: 60_000 },
    async ({ from, to }) => {
      const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
      expect({
        planned: plan.steps.length > 0,
        found: await overreach(from, plan.steps),
      }).toStrictEqual({ planned: true, found: [] });
    },
  );

  test.for([
    {
      problem: "scan, as SET NOT NULL without a valid check does",
      step: naive({
        kind: "setNotNull",
        object: "public.users.email",
        statements: ["ALTER TABLE users ALTER COLUMN email SET NOT NULL"],
        lock: "access exclusive",
      }),
      found: [`setNotNull public.users.email read ${String(ROWS)} rows of users`],
    },
    {
      problem: "lock harder than they say, as an ADD COLUMN said to take none",
      step: naive({
        kind: "addColumn",
        object: "public.users.note",
        statements: ["ALTER TABLE users ADD COLUMN note text"],
        lock: "none",
      }),
      found: ["addColumn public.users.note took AccessExclusiveLock on users"],
    },
  ])("are caught when they $problem", { timeout: 60_000 }, async ({ step, found }) => {
    await expect(overreach(users, [step])).resolves.toStrictEqual(found);
  });
});
