import { describe, expect, test } from "vitest";

import { migrate, summary } from "./test-migrate.ts";

describe("planMigration names what each step changes", () => {
  test.for<{ change: string; from: string; to: string; steps: string[] }>([
    {
      change: "tells apart tables whose schema and name join to the same text with a dot",
      from: 'create schema "a.b"; create table "a.b".c (id int8); create schema a',
      to: 'create schema "a.b"; create schema a; create table a."b.c" (id int8, note text)',
      steps: [
        'expand createTable a."b.c" (lossy, inside, none)',
        'contract dropTable "a.b".c (irreversible, inside, access exclusive)',
      ],
    },
    {
      change: "quotes names where Postgres would read the bare name as another",
      from: "",
      to: 'create schema "Billing"; create table "Billing"."say ""hi""" (id int8)',
      steps: [
        'expand createSchema "Billing" (reversible, inside, none)',
        'expand createTable "Billing"."say ""hi""" (lossy, inside, none)',
      ],
    },
  ])("and $change", async ({ from, to, steps }) => {
    const { plan, after, target } = await migrate(from, to);
    expect({
      steps: plan.steps.map((step) => summary(step)),
      manual: plan.manual,
      after,
    }).toStrictEqual({ steps, manual: [], after: target });
  });
});
