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

/** A table of bookings with `constraints` added. */
function bookings(constraints: string): string {
  return `create extension btree_gist;
    create table booking (room int8, during tstzrange${constraints})`;
}

const noOverlap = ", constraint no_overlap exclude using gist (during with &&)";
const temporalKey = ", constraint booking_room_during_key unique (room, during without overlaps)";

describe("planMigration of exclusion constraints and keys WITHOUT OVERLAPS", () => {
  test("creates a new table with them, as written", async () => {
    const plan = planMigration(
      await loadCatalog("create extension btree_gist"),
      await loadCatalog(bookings(`${noOverlap}${temporalKey}`)),
    );
    expect(plan.steps.map((step) => step.statements)).toStrictEqual([
      [
        'CREATE TABLE "public"."booking" ("room" bigint, "during" tstzrange, CONSTRAINT "booking_room_during_key" UNIQUE ("room", "during" WITHOUT OVERLAPS), CONSTRAINT "no_overlap" EXCLUDE USING gist (during WITH &&))',
      ],
    ]);
  });

  test.for([
    {
      change: "an exclusion constraint added",
      from: bookings(""),
      to: bookings(noOverlap),
      object: "public.booking.no_overlap",
      reason:
        "ottersql does not plan changes to an exclusion constraint yet; write this change by hand",
    },
    {
      change: "an exclusion constraint dropped",
      from: bookings(noOverlap),
      to: bookings(""),
      object: "public.booking.no_overlap",
      reason:
        "ottersql does not plan changes to an exclusion constraint yet; write this change by hand",
    },
    {
      change: "a key WITHOUT OVERLAPS added",
      from: bookings(""),
      to: bookings(temporalKey),
      object: "public.booking.booking_room_during_key",
      reason:
        "ottersql adds a key to a table with rows through a unique B-tree index built concurrently, which a key WITHOUT OVERLAPS cannot use; write this change by hand",
    },
  ])("leaves $change to a table with rows to a person", async ({ from, to, object, reason }) => {
    const plan = planMigration(await loadCatalog(from), await loadCatalog(to));
    expect(plan).toStrictEqual({ steps: [], manual: [{ object, reason }] });
  });

  test("adds a foreign key with PERIOD as written", async () => {
    const plan = planMigration(
      await loadCatalog(bookings(temporalKey)),
      await loadCatalog(
        `${bookings(temporalKey)};
        create table stay (room int8, at tstzrange,
          constraint stay_booking foreign key (room, period at) references booking (room, period during))`,
      ),
    );
    expect(plan.steps.flatMap((step) => step.statements)).toContain(
      'ALTER TABLE "public"."stay" ADD CONSTRAINT "stay_booking" FOREIGN KEY ("room", PERIOD "at") REFERENCES "public"."booking" ("room", PERIOD "during") ON UPDATE NO ACTION ON DELETE NO ACTION',
    );
  });
});

describe("planMigration of NO INHERIT and ON DELETE SET NULL (columns)", () => {
  test("writes them for a new table as the schema says", async () => {
    const plan = planMigration(
      await loadCatalog(""),
      await loadCatalog(`create table parent (tenant int4, id int4, primary key (tenant, id));
        create table child (
          tenant int4 not null no inherit, parent_id int4,
          constraint positive check (parent_id > 0) no inherit,
          constraint child_parent foreign key (tenant, parent_id) references parent
            on delete set null (parent_id)
        )`),
    );
    expect(plan.steps.flatMap((step) => step.statements).slice(0, 2)).toStrictEqual([
      'CREATE TABLE "public"."child" ("tenant" integer NOT NULL NO INHERIT, "parent_id" integer, CONSTRAINT "positive" CHECK ((parent_id > 0)) NO INHERIT)',
      'CREATE TABLE "public"."parent" ("tenant" integer NOT NULL, "id" integer NOT NULL, CONSTRAINT "parent_pkey" PRIMARY KEY ("tenant", "id"))',
    ]);
    expect(plan.steps.flatMap((step) => step.statements)).toContain(
      'ALTER TABLE "public"."child" ADD CONSTRAINT "child_parent" FOREIGN KEY ("tenant", "parent_id") REFERENCES "public"."parent" ("tenant", "id") ON UPDATE NO ACTION ON DELETE SET NULL ("parent_id")',
    );
  });

  test("adds a check NO INHERIT to a table with rows as such", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog(
        `${users}; alter table users add constraint positive check (id > 0) no inherit`,
      ),
    );
    expect(plan.steps[0]?.statements).toStrictEqual([
      'ALTER TABLE "public"."users" ADD CONSTRAINT "positive" CHECK ((id > 0)) NO INHERIT NOT VALID',
    ]);
  });

  test("leaves making a column of a table with rows NOT NULL NO INHERIT to a person", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog("create table users (id int8 primary key, email text not null no inherit)"),
    );
    expect(plan).toStrictEqual({
      steps: [],
      manual: [
        {
          object: "public.users.email",
          reason:
            "ottersql does not plan changes to NOT NULL NO INHERIT yet; write this change by hand",
        },
      ],
    });
  });
});
