import { describe, expect, test } from "vitest";

import { loadCatalog } from "../catalog/index.ts";
import { planMigration } from "./index.ts";
import { summary, users } from "./test-migrate.ts";

const touch = "create function touch() returns trigger language plpgsql as 'begin return new; end'";
const touched = `${users}; ${touch}`;

function byHand(kind: string): string {
  return `ottersql does not plan changes to ${kind} yet; write this change by hand`;
}

describe("planMigration of objects it does not plan", () => {
  test.for([
    {
      change: "a trigger added to a table",
      from: touched,
      to: `${touched}; create trigger users_touch before update on users for each row execute function touch()`,
      steps: [],
      manual: [{ object: "public.users.users_touch", reason: byHand("a trigger") }],
    },
    {
      change: "a trigger that fires on other events",
      from: `${touched}; create trigger users_touch before update on users for each row execute function touch()`,
      to: `${touched}; create trigger users_touch before insert or update on users for each row execute function touch()`,
      steps: [],
      manual: [{ object: "public.users.users_touch", reason: byHand("a trigger") }],
    },
    {
      change: "a new table's trigger",
      from: touch,
      to: `${touched}; create trigger users_touch before update on users for each row execute function touch()`,
      steps: ["expand createTable public.users (lossy, inside, none)"],
      manual: [{ object: "public.users.users_touch", reason: byHand("a trigger") }],
    },
    {
      change: "row-level security and a policy",
      from: users,
      to: `${users}; alter table users enable row level security; create policy own on users using (email is not null)`,
      steps: [],
      manual: [
        { object: "public.users", reason: byHand("row-level security") },
        { object: "public.users.own", reason: byHand("a policy") },
      ],
    },
    {
      change: "a policy's rule",
      from: `${users}; create policy own on users using (true)`,
      to: `${users}; create policy own on users using (email is not null)`,
      steps: [],
      manual: [{ object: "public.users.own", reason: byHand("a policy") }],
    },
    {
      change: "a function's body",
      from: "create function answer() returns int language sql as 'select 41'",
      to: "create function answer() returns int language sql as 'select 42'",
      steps: [],
      manual: [{ object: "public.answer", reason: byHand("a function") }],
    },
    {
      change: "a sequence no column owns",
      from: "",
      to: "create sequence tickets",
      steps: [],
      manual: [{ object: "public.tickets", reason: byHand("a sequence") }],
    },
    {
      change: "a sequence's settings",
      from: "create sequence tickets",
      to: "create sequence tickets increment by 2",
      steps: [],
      manual: [{ object: "public.tickets", reason: byHand("a sequence") }],
    },
    {
      change: "an extension",
      from: "",
      to: "create extension citext",
      steps: [],
      manual: [{ object: "public.citext", reason: byHand("an extension") }],
    },
    {
      change: "a column's collation",
      from: users,
      to: `create table users (id int8 primary key, email text collate "C")`,
      steps: [],
      manual: [
        {
          object: "public.users.email",
          reason:
            "Changing a column's collation rebuilds its indexes under an exclusive lock and can reorder what they hold; add a new column, backfill it and switch to it instead",
        },
      ],
    },
  ])("leaves $change to a person", async ({ from, to, steps, manual }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect({ steps: plan.steps.map((step) => summary(step)), manual: plan.manual }).toStrictEqual({
      steps,
      manual,
    });
  });
});

describe("planMigration of composite types", () => {
  const pair = "create type pair as (a int4, b text)";

  test("creates a new composite type before the tables that use it", async () => {
    const plan = planMigration(
      await loadCatalog(""),
      await loadCatalog(`${pair}; create table t (p pair)`),
    );
    expect({
      steps: plan.steps.map((step) => [summary(step), ...step.statements]),
      manual: plan.manual,
    }).toStrictEqual({
      steps: [
        [
          "expand createType public.pair (lossy, inside, none)",
          'CREATE TYPE "public"."pair" AS ("a" integer, "b" text)',
        ],
        [
          "expand createTable public.t (lossy, inside, none)",
          'CREATE TABLE "public"."t" ("p" pair)',
        ],
      ],
      manual: [],
    });
  });

  test.for([
    {
      change: "an attribute added",
      from: pair,
      to: "create type pair as (a int4, b text, c int8)",
    },
    { change: "a type dropped", from: pair, to: "" },
  ])("leaves a composite type's change, $change, to a person", async ({ from, to }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect(plan).toStrictEqual({
      steps: [],
      manual: [{ object: "public.pair", reason: byHand("a composite type") }],
    });
  });
});
