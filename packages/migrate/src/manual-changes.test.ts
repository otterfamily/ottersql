import { loadCatalog } from "@ottersql/catalog";
import { describe, expect, test } from "vitest";

import { planMigration } from "./index.ts";
import { users, uuid7 } from "./test-migrate.ts";

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
      to: `${uuid7}; create table users (id int8 primary key, email text, token uuid default my_uuid7())`,
      object: "public.users.token",
      reason:
        "A volatile default is computed for every existing row, which rewrites the table under an exclusive lock; add the column without a default, set the default, and backfill in batches",
    },
    {
      change: "a stored generated column",
      to: `${uuid7}; create table users (id int8 primary key, email text, domain text generated always as (split_part(email, '@', 2)) stored)`,
      object: "public.users.domain",
      reason:
        "Adding a stored generated column rewrites the table under an exclusive lock; add a virtual one, or add a plain column, backfill it in batches and fill it with a trigger",
    },
  ])(
    "leaves adding $change to an existing table to be handled by hand",
    async ({ to, object, reason }) => {
      const plan = planMigration(await loadCatalog(`${uuid7}; ${users}`), await loadCatalog(to));
      expect(plan).toStrictEqual({ steps: [], manual: [{ object, reason }] });
    },
  );

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
