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
      change: "a collation",
      from: "",
      to: "create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)",
      steps: [],
      manual: [{ object: "public.ci", reason: byHand("a collation") }],
    },
    {
      change: "a collation's locale",
      from: "create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)",
      to: "create collation ci (provider = icu, locale = 'und-u-ks-level1', deterministic = false)",
      steps: [],
      manual: [{ object: "public.ci", reason: byHand("a collation") }],
    },
    {
      change: "a text search configuration",
      from: "",
      to: "create text search configuration plain (copy = simple)",
      steps: [],
      manual: [{ object: "public.plain", reason: byHand("a text search configuration") }],
    },
    {
      change: "a text search configuration's dictionaries",
      from: "create text search configuration plain (copy = simple)",
      to: `create text search configuration plain (copy = simple);
        alter text search configuration plain drop mapping for word`,
      steps: [],
      manual: [{ object: "public.plain", reason: byHand("a text search configuration") }],
    },
    {
      change: "a text search dictionary",
      from: "",
      to: "create text search dictionary plain_dict (template = simple, stopwords = english)",
      steps: [],
      manual: [{ object: "public.plain_dict", reason: byHand("a text search dictionary") }],
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

describe("planMigration of tables that use what it leaves to a person", () => {
  const positive = "create domain positive as int4 check (value > 0)";
  const forTable =
    "public.t uses public.positive, which this plan leaves to a person; create the table by hand after it";
  const forColumn =
    "public.t.a uses public.positive, which this plan leaves to a person; add the column by hand after it";

  test.for([
    {
      change: "a new table of a new domain",
      from: "",
      to: `${positive}; create table t (a positive)`,
      object: "public.t",
      reason: forTable,
    },
    {
      change: "a new table of an array of a new domain",
      from: "",
      to: `${positive}; create table t (a positive[])`,
      object: "public.t",
      reason: forTable,
    },
    {
      change: "a new column of a new domain",
      from: "create table t (id int8)",
      to: `${positive}; create table t (id int8, a positive)`,
      object: "public.t.a",
      reason: forColumn,
    },
  ])("leaves $change to a person with it", async ({ from, to, object, reason }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        { object, reason },
        { object: "public.positive", reason: byHand("a domain") },
      ],
    });
  });

  test("leaves a new table of a new collation to a person with it", async () => {
    const collation =
      "create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)";
    const plan = planMigration(
      await loadCatalog(""),
      await loadCatalog(`${collation}; create table t (a text collate ci)`),
    );
    expect(plan.manual.map(({ object }) => object)).toStrictEqual(["public.t", "public.ci"]);
  });
});
