import { describe, expect, test } from "vitest";

import { loadCatalog } from "../../catalog/index.ts";
import { planMigration } from "../index.ts";
import { users } from "../test-migrate.ts";

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

describe("planMigration of identity settings, column storage and table storage", () => {
  const settings = `create unlogged table t (
      id int8 generated always as identity (start with 100 increment by 5),
      b text storage external compression pglz
    ) with (fillfactor = 70);
    create index t_b on t (b) with (fillfactor = 50)`;

  test("writes them for a new table", async () => {
    const plan = planMigration(await loadCatalog(""), await loadCatalog(settings));
    expect(plan.steps.map((step) => step.statements)).toStrictEqual([
      [
        'CREATE UNLOGGED TABLE "public"."t" ("id" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME "public"."t_id_seq" INCREMENT BY 5 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100 CACHE 1 NO CYCLE) NOT NULL, "b" text COMPRESSION pglz) WITH (fillfactor=70)',
        'ALTER TABLE "public"."t" ALTER COLUMN "b" SET STORAGE EXTERNAL',
        'CREATE INDEX "t_b" ON "public"."t" USING btree ("b") WITH (fillfactor=50)',
      ],
    ]);
  });

  const plainTable = "create table t (id int8 generated always as identity, b text)";

  test.for([
    {
      change: "an identity's settings",
      to: "create table t (id int8 generated always as identity (increment by 5), b text)",
      object: "public.t.id",
      reason: "ottersql does not plan changes to serial, identity or generated columns yet",
    },
    {
      change: "a column's compression",
      to: "create table t (id int8 generated always as identity, b text compression pglz)",
      object: "public.t.b",
      reason:
        "ottersql does not plan changes to a column's storage or compression yet; write this change by hand",
    },
    {
      change: "a table becoming unlogged",
      to: "create unlogged table t (id int8 generated always as identity, b text)",
      object: "public.t",
      reason:
        "ottersql does not plan changes to whether a table is logged, or to its storage parameters, yet; write this change by hand",
    },
    {
      change: "a table's storage parameters",
      to: `${plainTable} with (fillfactor = 70)`,
      object: "public.t",
      reason:
        "ottersql does not plan changes to whether a table is logged, or to its storage parameters, yet; write this change by hand",
    },
  ])("leaves $change on a table with rows to a person", async ({ to, object, reason }) => {
    const plan = planMigration(await loadCatalog(plainTable), await loadCatalog(to));
    expect(plan).toStrictEqual({ steps: [], manual: [{ object, reason }] });
  });
});

/** A table whose unique key, check and index carry the comment `text`. */
function commented(text: string): string {
  return `create table t (id int8, code text,
      constraint t_code unique (code), constraint t_positive check (id > 0));
    create index t_lower on t (lower(code));
    comment on constraint t_code on t is '${text}';
    comment on constraint t_positive on t is '${text}';
    comment on index t_lower is '${text}'`;
}

/** A table whose check `c`, NOT VALID or not as `valid` says, carries the comment `text`. */
function withCheck(valid: string, text: string): string {
  return `create table t (n int4); alter table t add constraint c check (n > 0)${valid};
    comment on constraint c on t is '${text}'`;
}

describe("planMigration of comments on constraints and indexes", () => {
  test("writes them for a new table", async () => {
    const plan = planMigration(await loadCatalog(""), await loadCatalog(commented("New")));
    expect(plan.steps.flatMap((step) => step.statements).slice(-3)).toStrictEqual([
      `COMMENT ON CONSTRAINT "t_code" ON "public"."t" IS 'New'`,
      `COMMENT ON CONSTRAINT "t_positive" ON "public"."t" IS 'New'`,
      `COMMENT ON INDEX "public"."t_lower" IS 'New'`,
    ]);
  });

  test("changes only the comments when only they change", async () => {
    const plan = planMigration(
      await loadCatalog(commented("Old")),
      await loadCatalog(commented("New")),
    );
    expect({
      kinds: plan.steps.map((step) => step.kind),
      statements: plan.steps.flatMap((step) => step.statements),
      manual: plan.manual,
    }).toStrictEqual({
      kinds: ["comment", "comment", "comment"],
      statements: [
        `COMMENT ON CONSTRAINT "t_positive" ON "public"."t" IS 'New'`,
        `COMMENT ON CONSTRAINT "t_code" ON "public"."t" IS 'New'`,
        `COMMENT ON INDEX "public"."t_lower" IS 'New'`,
      ],
      manual: [],
    });
  });

  test("changes the comment of a constraint it validates", async () => {
    const plan = planMigration(
      await loadCatalog(withCheck(" not valid", "Old")),
      await loadCatalog(withCheck("", "New")),
    );
    expect(plan.steps.map((step) => `${step.kind} ${step.object}`).toSorted()).toStrictEqual([
      "comment public.t.c",
      "validateCheck public.t.c",
    ]);
  });
});
