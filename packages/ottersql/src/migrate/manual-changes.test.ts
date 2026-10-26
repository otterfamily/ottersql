import { describe, expect, test } from "vitest";

import { loadCatalog } from "../catalog/index.ts";
import { planMigration } from "./index.ts";
import { users, uuid7 } from "./test-migrate.ts";

const domains = `create domain positive as int check (value > 0);
  create domain required as int not null default 1;
  create domain still_positive as positive;
  create sequence tickets;
  create domain ticket as int8 default nextval('tickets');
  create domain still_ticket as ticket;
  create domain label as text default 'none'`;

const uniqueReason =
  "A changed unique key that neither only adds columns nor only removes them, or that a foreign key refers to, cannot be swapped safely without knowing its intent; write the change by hand";
const checkedRowByRow =
  "A column of a domain with a CHECK or NOT NULL is checked row by row, which rewrites the table under an exclusive lock; use the base type with a CHECK constraint instead, which is validated without blocking writes";
const volatileDomainDefault =
  "The domain's default is volatile, so it is computed for every existing row, which rewrites the table under an exclusive lock; add the column with DEFAULT NULL, which overrides it, then drop that default and backfill in batches";

describe("planMigration", () => {
  test("leaves nothing to do between equal schemas", async () => {
    const schema = `${users}; create type mood as enum ('ok'); create index on users (email)`;
    const plan = planMigration(await loadCatalog(schema), await loadCatalog(schema));
    expect(plan).toStrictEqual({ steps: [], manual: [] });
  });

  test("leaves a column's type change to be handled by hand, saying why", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog("create table users (id int8 primary key, email varchar(320))"),
    );
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        {
          object: "public.users.email",
          reason:
            "Changing a column's type can rewrite the table under an exclusive lock; add a new column, backfill it and switch to it instead",
        },
      ],
    });
  });

  test.for([
    {
      change: "a column whose default calls a volatile function",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, token uuid default my_uuid7())`,
      object: "public.users.token",
      reason:
        "A volatile default is computed for every existing row, which rewrites the table under an exclusive lock; add the column without a default, set the default, and backfill in batches",
    },
    {
      change: "a column of a domain with a check",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, score positive)`,
      object: "public.users.score",
      reason: checkedRowByRow,
    },
    {
      change: "a column of a domain that is NOT NULL",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, level required)`,
      object: "public.users.level",
      reason: checkedRowByRow,
    },
    {
      change: "a column of a domain over a domain with a check",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, score still_positive)`,
      object: "public.users.score",
      reason: checkedRowByRow,
    },
    {
      change: "a column of a domain whose default is volatile",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, ticket ticket)`,
      object: "public.users.ticket",
      reason: volatileDomainDefault,
    },
    {
      change: "a column of a domain over one whose default is volatile",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, ticket still_ticket)`,
      object: "public.users.ticket",
      reason: volatileDomainDefault,
    },
    {
      change: "a serial column",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, n serial)`,
      object: "public.users.n",
      reason:
        "Adding a serial column rewrites the table under an exclusive lock to number every row; add a nullable column, backfill it in batches, then set its default to the sequence",
    },
    {
      change: "a stored generated column",
      to: `${uuid7}; ${domains}; create table users (id int8 primary key, email text, domain text generated always as (split_part(email, '@', 2)) stored)`,
      object: "public.users.domain",
      reason:
        "Adding a stored generated column rewrites the table under an exclusive lock; add a virtual one, or add a plain column, backfill it in batches and fill it with a trigger",
    },
  ])(
    "leaves adding $change to an existing table to be handled by hand",
    async ({ to, object, reason }) => {
      const plan = planMigration(
        await loadCatalog(`${uuid7}; ${domains}; ${users}`),
        await loadCatalog(to),
      );
      expect(plan).toStrictEqual({ steps: [], manual: [{ object, reason }] });
    },
  );

  test("adds a column of a domain without constraints or a volatile default in one step", async () => {
    const plan = planMigration(
      await loadCatalog(`${domains}; ${users}`),
      await loadCatalog(
        `${domains}; create table users (id int8 primary key, email text, tag label)`,
      ),
    );
    expect(plan.steps.map(({ kind, object }) => `${kind} ${object}`)).toStrictEqual([
      "addColumn public.users.tag",
    ]);
  });

  test.for([
    {
      change: "a column dropped and another of the same type added",
      to: "create table users (id int8 primary key, mail text)",
      object: "public.users.email",
      reason:
        "public.users.email is dropped and public.users.mail of the same type is added, which may be a rename that would lose the column's data; write it by hand: RENAME COLUMN for a rename (or add, backfill and switch, to keep the old app working), or DROP COLUMN and ADD COLUMN otherwise",
    },
    {
      change: "a table dropped and another with the same columns created",
      to: "create table accounts (id int8 primary key, email text)",
      object: "public.users",
      reason:
        "public.users is dropped and public.accounts with the same columns is created, which may be a rename that would lose the table's data; write it by hand: RENAME for a rename, or DROP TABLE and CREATE TABLE otherwise",
    },
  ])(
    "leaves what may be a rename to be written by hand: $change",
    async ({ to, object, reason }) => {
      const plan = planMigration(await loadCatalog(users), await loadCatalog(to));
      expect(plan).toStrictEqual({ steps: [], manual: [{ object, reason }] });
    },
  );

  test.for([
    {
      change: "unique key on other columns",
      from: "create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (email))",
      to: "create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (tenant))",
      object: "public.users.users_key",
      reason: uniqueReason,
    },
    {
      change: "unique key a foreign key refers to",
      from: `create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (email));
        create table invites (email text references users (email))`,
      to: `create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (email, tenant));
        create table invites (email text)`,
      object: "public.users.users_key",
      reason: uniqueReason,
    },
    {
      change: "primary key",
      from: "create table users (id int8, tenant int8 not null, constraint users_pkey primary key (id))",
      to: "create table users (id int8, tenant int8 not null, constraint users_pkey primary key (id, tenant))",
      object: "public.users.users_pkey",
      reason:
        "A changed primary key is left to a person: foreign keys often refer to it and its columns must be NOT NULL; write the change by hand",
    },
    {
      change: "column that becomes serial",
      from: "create table users (id int8 primary key, n int4)",
      to: "create table users (id int8 primary key, n serial)",
      object: "public.users.n",
      reason: "ottersql does not plan changes to serial, identity or generated columns yet",
    },
    {
      change: "column that stops being serial",
      from: "create table users (id int8 primary key, n serial)",
      to: "create table users (id int8 primary key, n int4 not null default 0)",
      object: "public.users.n",
      reason: "ottersql does not plan changes to serial, identity or generated columns yet",
    },
  ])("leaves a changed $change to be written by hand", async ({ from, to, object, reason }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect(plan.manual).toStrictEqual([{ object, reason }]);
  });

  test("leaves new and changed functions to be written by hand", async () => {
    const plan = planMigration(await loadCatalog(users), await loadCatalog(`${uuid7}; ${users}`));
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        {
          object: "public.my_uuid7",
          reason: "ottersql does not plan changes to a function yet; write this change by hand",
        },
      ],
    });
  });

  test("makes a column NOT NULL with statements that never scan the table under an exclusive lock", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog("create table users (id int8 primary key, email text not null)"),
    );
    expect(plan.steps.map((step) => step.statements)).toStrictEqual([
      [
        'ALTER TABLE "public"."users" ADD CONSTRAINT "ottersql_not_null_email" CHECK ("email" IS NOT NULL) NOT VALID',
      ],
      ['ALTER TABLE "public"."users" VALIDATE CONSTRAINT "ottersql_not_null_email"'],
      [
        'ALTER TABLE "public"."users" ALTER COLUMN "email" SET NOT NULL',
        'ALTER TABLE "public"."users" DROP CONSTRAINT "ottersql_not_null_email"',
      ],
    ]);
  });
});
