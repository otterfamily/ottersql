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
      steps: ["expand dropNotNull public.users.email (reversible, inside, access exclusive)"],
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
