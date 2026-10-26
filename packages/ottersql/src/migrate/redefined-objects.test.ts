import { describe, expect, test } from "vitest";

import { loadCatalog } from "../catalog/index.ts";
import { planMigration } from "./index.ts";
import { users } from "./test-migrate.ts";

/** A table partitioned by date with `columns` added, and one partition of it. */
function partitioned(columns: string): string {
  return `create table events (id int8, at date${columns}) partition by range (at);
    create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01')`;
}

/** A table, and one that inherits from it with `columns` added. */
function inheriting(columns: string): string {
  return `create table base (id int8); create table child (note text${columns}) inherits (base)`;
}

/** The users table, and posts whose foreign key to it is on `column`. */
function postsReferringBy(column: string): string {
  return `${users};
    create table posts (id int8 primary key, a int8, b int8,
      constraint posts_author foreign key (${column}) references users)`;
}

describe("planMigration of changed constraints and partitioned tables", () => {
  test.for([
    { change: "creating", from: "", to: partitioned("") },
    { change: "changing", from: partitioned(""), to: partitioned(", note text") },
    { change: "dropping", from: partitioned(""), to: "" },
  ])("leaves $change a partitioned table and its partitions to a person", async ({ from, to }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    const reason =
      "ottersql does not plan partitioned tables or their partitions yet; write this change by hand";
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        { object: "public.events", reason },
        { object: "public.events_2026", reason },
      ],
    });
  });

  test.for([
    { change: "creating", from: "", to: inheriting(""), changed: ["public.base", "public.child"] },
    {
      change: "changing",
      from: inheriting(""),
      to: inheriting(", extra int4"),
      changed: ["public.child"],
    },
    { change: "dropping", from: inheriting(""), to: "", changed: ["public.base", "public.child"] },
    {
      change: "inheriting from an unchanged table",
      from: "create table base (id int8)",
      to: inheriting(""),
      changed: ["public.child"],
    },
  ])(
    "leaves $change tables that inherit from others, or are inherited from, to a person",
    async ({ from, to, changed }) => {
      const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
      const reason =
        "ottersql does not plan tables that inherit from others or are inherited from (INHERITS) yet; write this change by hand";
      expect(plan).toStrictEqual({
        steps: [],
        manual: changed.map((object) => ({ object, reason })),
      });
    },
  );

  test("leaves a foreign key that now refers to other columns to be changed by hand", async () => {
    const plan = planMigration(
      await loadCatalog(postsReferringBy("a")),
      await loadCatalog(postsReferringBy("b")),
    );
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        {
          object: "public.posts.posts_author",
          reason:
            "A foreign key that now refers from or to other columns would stop rows of the old app or of the new one while both run; change it by hand: add the new key, deploy, then drop the old one",
        },
      ],
    });
  });

  test("replaces a changed check through one that allows what either check allows", async () => {
    const plan = planMigration(
      await loadCatalog(
        `${users}; alter table users add constraint email_has_at check (email like '%@%')`,
      ),
      await loadCatalog(
        `${users}; alter table users add constraint email_has_at check (email like '%@%.%')`,
      ),
    );
    expect(plan.steps.map((step) => step.statements)).toStrictEqual([
      [
        `ALTER TABLE "public"."users" ADD CONSTRAINT "ottersql_old_or_new_email_has_at" CHECK (((email ~~ '%@%'::text)) OR ((email ~~ '%@%.%'::text))) NOT VALID`,
        'ALTER TABLE "public"."users" DROP CONSTRAINT "email_has_at"',
      ],
      [
        `ALTER TABLE "public"."users" ADD CONSTRAINT "ottersql_new_email_has_at" CHECK ((email ~~ '%@%.%'::text)) NOT VALID`,
      ],
      ['ALTER TABLE "public"."users" VALIDATE CONSTRAINT "ottersql_new_email_has_at"'],
      [
        'ALTER TABLE "public"."users" DROP CONSTRAINT "ottersql_old_or_new_email_has_at"',
        'ALTER TABLE "public"."users" RENAME CONSTRAINT "ottersql_new_email_has_at" TO "email_has_at"',
      ],
    ]);
  });
});
