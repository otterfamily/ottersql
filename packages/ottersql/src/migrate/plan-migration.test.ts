import { describe, expect, test } from "vitest";

import { migrate, summary, users, uuid7 } from "./test-migrate.ts";

describe("planMigration, run on PGlite to the target schema", () => {
  test.for<{ change: string; from: string; to: string; steps: string[] }>([
    {
      change: "creates a table with its keys, checks and indexes",
      from: "",
      to: `create table users (
        id int8 primary key, email text not null unique, age int4 check (age >= 0)
      );
      create index users_age on users (age desc nulls last) where age > 17;`,
      steps: ["expand createTable public.users (lossy, inside, none)"],
    },
    {
      change: "creates a schema before the objects in it",
      from: "",
      to: "create schema app; create type app.mood as enum ('ok'); create table app.notes (id int8 primary key, mood app.mood)",
      steps: [
        "expand createSchema app (reversible, inside, none)",
        "expand createEnum app.mood (lossy, inside, none)",
        "expand createTable app.notes (lossy, inside, none)",
      ],
    },
    {
      change: "drops a schema after the objects in it",
      from: "create schema app; create table app.notes (id int8 primary key)",
      to: "",
      steps: [
        "contract dropTable app.notes (irreversible, inside, access exclusive)",
        "contract dropSchema app (irreversible, inside, none)",
      ],
    },
    {
      change: "comments a schema",
      from: "create schema app",
      to: "create schema app; comment on schema app is 'Billing'",
      steps: ["expand comment app (reversible, inside, none)"],
    },
    {
      change: "widens varchar columns in place before the deploy, which rewrites no rows",
      from: "create table users (id int8 primary key, email varchar(100), name varchar(50), bio varchar(10))",
      to: "create table users (id int8 primary key, email varchar(320), name text, bio varchar)",
      steps: [
        "expand widenColumn public.users.email (lossy, inside, access exclusive)",
        "expand widenColumn public.users.name (lossy, inside, access exclusive)",
        "expand widenColumn public.users.bio (lossy, inside, access exclusive)",
      ],
    },
    {
      change: "drops a table after the deploy",
      from: users,
      to: "",
      steps: ["contract dropTable public.users (irreversible, inside, access exclusive)"],
    },
    {
      change: "adds a column before the deploy",
      from: users,
      to: "create table users (id int8 primary key, email text, name text not null default '')",
      steps: ["expand addColumn public.users.name (lossy, inside, access exclusive)"],
    },
    {
      change: "drops a column after the deploy",
      from: users,
      to: "create table users (id int8 primary key)",
      steps: ["contract dropColumn public.users.email (irreversible, inside, access exclusive)"],
    },
    {
      change: "makes a column NOT NULL through a validated check, so writes are not blocked",
      from: users,
      to: "create table users (id int8 primary key, email text not null)",
      steps: [
        "contract addCheck public.users.ottersql_not_null_email (reversible, inside, access exclusive)",
        "contract validateCheck public.users.ottersql_not_null_email (reversible, inside, share update exclusive)",
        "contract setNotNull public.users.email (reversible, inside, access exclusive)",
      ],
    },
    {
      change: "drops NOT NULL before the deploy",
      from: "create table users (id int8 primary key, email text not null)",
      to: users,
      steps: ["expand dropNotNull public.users.email (lossy, inside, access exclusive)"],
    },
    {
      change:
        "drops a check and a foreign key before the deploy, which cannot be put back once rows break them",
      from: `${users}; create table posts (id int8 primary key, author_id int8 references users check (author_id > 0))`,
      to: `${users}; create table posts (id int8 primary key, author_id int8)`,
      steps: [
        "expand dropForeignKey public.posts.posts_author_id_fkey (lossy, inside, access exclusive)",
        "expand dropConstraint public.posts.posts_author_id_check (lossy, inside, access exclusive)",
      ],
    },
    {
      change: "validates a check that was NOT VALID, with VALIDATE alone",
      from: `${users}; alter table users add constraint email_has_at check (email like '%@%') not valid`,
      to: `${users}; alter table users add constraint email_has_at check (email like '%@%')`,
      steps: [
        "contract validateCheck public.users.email_has_at (reversible, inside, share update exclusive)",
      ],
    },
    {
      change: "validates a foreign key that was NOT VALID, with VALIDATE alone",
      from: `${users}; create table posts (id int8 primary key, author_id int8);
        alter table posts add foreign key (author_id) references users not valid`,
      to: `${users}; create table posts (id int8 primary key, author_id int8);
        alter table posts add foreign key (author_id) references users`,
      steps: [
        "contract validateForeignKey public.posts.posts_author_id_fkey (reversible, inside, share update exclusive)",
      ],
    },
    {
      change:
        "widens a unique key before the deploy: the new key is built first, then takes the old one's place",
      from: "create table users (id int8 primary key, email text, tenant int8, unique (email))",
      to: "create table users (id int8 primary key, email text, tenant int8, unique (email, tenant))",
      steps: [
        "expand createIndex public.users.users_email_tenant_key (reversible, outside, share update exclusive)",
        "expand addUnique public.users.users_email_tenant_key (lossy, inside, access exclusive)",
      ],
    },
    {
      change: "widens a unique key that keeps its name, building it under a temporary name",
      from: "create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (email))",
      to: "create table users (id int8 primary key, email text, tenant int8, constraint users_key unique (email, tenant))",
      steps: [
        "expand createIndex public.users.ottersql_new_users_key (reversible, outside, share update exclusive)",
        "expand addUnique public.users.users_key (lossy, inside, access exclusive)",
      ],
    },
    {
      change: "narrows a unique key after the deploy, the old one holding until the new one does",
      from: "create table users (id int8 primary key, email text, tenant int8, unique (email, tenant))",
      to: "create table users (id int8 primary key, email text, tenant int8, unique (email))",
      steps: [
        "contract createIndex public.users.users_email_key (reversible, outside, share update exclusive)",
        "contract addUnique public.users.users_email_key (reversible, inside, access exclusive)",
      ],
    },
    {
      change: "rebuilds a changed index under a temporary name, so queries never go without it",
      from: `${users}; create index users_lookup on users (email)`,
      to: `${users}; create index users_lookup on users (lower(email))`,
      steps: [
        "contract createIndex public.users.ottersql_new_users_lookup (reversible, outside, share update exclusive)",
        "contract dropIndex public.users.users_lookup (reversible, outside, share update exclusive)",
        "contract renameIndex public.users.users_lookup (reversible, inside, share update exclusive)",
      ],
    },
    {
      change: "adds a foreign key unvalidated, then validates it",
      from: `${users}; create table posts (id int8 primary key, author_id int8)`,
      to: `${users}; create table posts (id int8 primary key, author_id int8 references users)`,
      steps: [
        "contract addForeignKey public.posts.posts_author_id_fkey (reversible, inside, share row exclusive)",
        "contract validateForeignKey public.posts.posts_author_id_fkey (reversible, inside, share update exclusive)",
      ],
    },
    {
      change: "adds a unique constraint through an index built concurrently",
      from: users,
      to: "create table users (id int8 primary key, email text unique)",
      steps: [
        "contract createIndex public.users.users_email_key (reversible, outside, share update exclusive)",
        "contract addUnique public.users.users_email_key (reversible, inside, access exclusive)",
      ],
    },
    {
      change: "builds and drops indexes concurrently",
      from: `${users}; create index users_old on users (id)`,
      to: `${users}; create index users_email on users (lower(email))`,
      steps: [
        "expand createIndex public.users.users_email (reversible, outside, share update exclusive)",
        "contract dropIndex public.users.users_old (reversible, outside, share update exclusive)",
      ],
    },
    {
      change: "adds enum values in place, before the deploy",
      from: "create type mood as enum ('ok')",
      to: "create type mood as enum ('sad', 'ok', 'happy')",
      steps: [
        "expand addEnumValue public.mood.sad (irreversible, inside, none)",
        "expand addEnumValue public.mood.happy (irreversible, inside, none)",
      ],
    },
    {
      change: "creates a table with serial columns together with the sequences they own",
      from: "",
      to: `create table tickets (id bigserial primary key, seat smallserial, n int4);
        alter sequence tickets_seat_seq increment by 2 cycle`,
      steps: ["expand createTable public.tickets (lossy, inside, none)"],
    },
    {
      change: "creates a table whose id defaults to a function the schema defines",
      from: uuid7,
      to: `${uuid7}; create table events (id uuid primary key default my_uuid7())`,
      steps: ["expand createTable public.events (lossy, inside, none)"],
    },
    {
      change: "adds a virtual generated column, which no row stores",
      from: users,
      to: "create table users (id int8 primary key, email text, domain text generated always as (split_part(email, '@', 2)) virtual)",
      steps: ["expand addColumn public.users.domain (lossy, inside, access exclusive)"],
    },
    {
      change:
        "adds a NOT NULL column without a default as nullable, and makes it NOT NULL after the deploy",
      from: users,
      to: "create table users (id int8 primary key, email text, name text not null)",
      steps: [
        "expand addColumn public.users.name (lossy, inside, access exclusive)",
        "contract addCheck public.users.ottersql_not_null_name (reversible, inside, access exclusive)",
        "contract validateCheck public.users.ottersql_not_null_name (reversible, inside, share update exclusive)",
        "contract setNotNull public.users.name (reversible, inside, access exclusive)",
      ],
    },
    {
      change: "creates tables that refer to each other, adding their foreign keys once both exist",
      from: "",
      to: `create table a (id int8 primary key, b_id int8);
        create table b (id int8 primary key, a_id int8 references a);
        alter table a add foreign key (b_id) references b;`,
      steps: [
        "expand createTable public.a (lossy, inside, none)",
        "expand createTable public.b (lossy, inside, none)",
        "expand addForeignKey public.a.a_b_id_fkey (reversible, inside, share row exclusive)",
        "expand addForeignKey public.b.b_a_id_fkey (reversible, inside, share row exclusive)",
      ],
    },
  ])("$change", async ({ from, to, steps }) => {
    const { plan, after, target } = await migrate(from, to);
    expect({
      steps: plan.steps.map((step) => summary(step)),
      manual: plan.manual,
      after,
    }).toStrictEqual({ steps, manual: [], after: target });
  });
});
