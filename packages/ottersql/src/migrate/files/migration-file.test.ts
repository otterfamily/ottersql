import { describe, expect, test } from "vitest";

import { loadCatalog } from "../../catalog/index.ts";
import { pendingChanges, planMigration, readMigrationFile, renderMigration } from "../index.ts";
import type { Step } from "../index.ts";
import { users } from "../test-migrate.ts";

const inside =
  '-- ottersql:step kind=comment object="public.t" phase=expand reversal=reversible transaction=inside lock="none"';
const outside =
  '-- ottersql:step kind=createIndex object="public.t.i" phase=expand reversal=reversible transaction=outside lock="share update exclusive"';

/** The name and message of what `run` throws. */
function failure(run: () => unknown): { readonly name: string; readonly message: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? { name: error.name, message: error.message } : null;
  }
}

/** Reasons are comments in the file, for reviewers; reading it back leaves them out. */
function withoutReason(step: Step): Step {
  return { ...step, reason: null };
}

describe("migration files", () => {
  test.for([
    {
      names: "plain names",
      to: "create table users (id int8 primary key, email text not null unique check (email <> 'a;b'))",
    },
    {
      names: "names shown in quotes",
      to: `${users}; create table "Say ""hi""" (id int8 primary key, "e mail" text not null unique)`,
    },
  ])(
    "read back the steps they were rendered from, with $names, so a plan survives review in a file",
    async ({ to }) => {
      const plan = planMigration(await loadCatalog(users), await loadCatalog(to));
      const steps = readMigrationFile(renderMigration(plan));
      expect(steps).toStrictEqual(plan.steps.map(withoutReason));
    },
  );

  test("list the changes left to a person as comments, which the check keeps failing on", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog("create table users (id int8 primary key, email varchar(320))"),
    );
    expect(renderMigration(plan)).toBe(
      [
        "-- ottersql:manual public.users.email",
        "-- Changing a column's type can rewrite the table under an exclusive lock; add a new column, backfill it and switch to it instead",
        "",
      ].join("\n"),
    );
  });

  test.for([
    {
      problem: "SQL before the first step",
      text: "select 1;",
      message: "line 1: SQL must follow a -- ottersql:step line",
    },
    {
      problem: "an unknown phase",
      text: '-- ottersql:step kind=addColumn object=t phase=later reversal=lossy transaction=inside lock="none"\nselect 1;',
      message: 'line 1: phase must be one of expand, contract, not "later"',
    },
    {
      problem: "a missing attribute",
      text: "-- ottersql:step kind=addColumn object=t phase=expand reversal=lossy transaction=inside\nselect 1;",
      message: "line 1: lock is missing",
    },
    {
      problem: "a step without SQL",
      text: '-- ottersql:step kind=addColumn object=t phase=expand reversal=lossy transaction=inside lock="none"\n',
      message: "line 1: the step has no SQL",
    },
    {
      problem: "an unknown directive",
      text: '-- ottersql:stpe kind=comment object=t phase=expand reversal=reversible transaction=inside lock="none"\nselect 1;',
      message:
        "line 1: unknown directive ottersql:stpe; the directives are step, cleanup and manual",
    },
    {
      problem: "a directive after SQL on its line",
      text: `${inside}\nselect 1; -- ottersql:step kind=comment object=t phase=expand reversal=reversible transaction=inside lock="none"\nselect 2;`,
      message: "line 2: a -- ottersql: directive must be on a line of its own",
    },
    {
      problem: "an attribute given twice",
      text: '-- ottersql:step kind=comment object=t phase=expand phase=contract reversal=reversible transaction=inside lock="none"\nselect 1;',
      message: "line 1: phase is given twice",
    },
    {
      problem: "an unknown attribute",
      text: '-- ottersql:step kind=comment object=t phase=expand reversal=reversible transaction=inside lock="none" bogus=1\nselect 1;',
      message: "line 1: unknown attribute bogus",
    },
    {
      problem: "text that is not an attribute",
      text: '-- ottersql:step kind=comment object=t phase=expand reversal=reversible transaction=inside lock="none" oops\nselect 1;',
      message: 'line 1: expected attributes such as key=value, not "oops"',
    },
    {
      problem: "a cleanup on a step inside a transaction",
      text: `${inside}\n-- ottersql:cleanup schema="public" index="i"\nselect 1;`,
      message: "line 2: only a step outside a transaction has a cleanup",
    },
    {
      problem: "two cleanups",
      text: `${outside}\n-- ottersql:cleanup schema="public" index="i"\n-- ottersql:cleanup schema="public" index="j"\ncreate index concurrently i on t (id);`,
      message: "line 3: a step has one cleanup at most",
    },
    {
      problem: "two statements in a step outside a transaction, which a rerun could not resume",
      text: `${outside}\ncreate index concurrently i on t (id);\ncreate index concurrently j on t (id);`,
      message:
        "line 1: a step outside a transaction has one statement; put each in a step of its own",
    },
  ])("reject $problem, naming the line", ({ text, message }) => {
    expect(failure(() => readMigrationFile(text))).toStrictEqual({
      name: "MigrationFileError",
      message,
    });
  });

  test("read a step written by hand with only its object at the safest settings, which wait for approval", () => {
    const text =
      '-- ottersql:step kind=custom object="public.users"\nupdate users set nickname = name;';
    expect(readMigrationFile(text)).toStrictEqual([
      {
        kind: "custom",
        object: "public.users",
        phase: "contract",
        reversal: "irreversible",
        transaction: "inside",
        lock: "access exclusive",
        statements: ["update users set nickname = name"],
        reason: null,
      },
    ]);
  });

  test("keep what a step written by hand says about itself", () => {
    const text =
      '-- ottersql:step kind=custom object="public.users" phase=expand reversal=reversible lock="row exclusive"\nupdate users set nickname = name;';
    expect(
      readMigrationFile(text).map(({ phase, reversal, lock }) => ({ phase, reversal, lock })),
    ).toStrictEqual([{ phase: "expand", reversal: "reversible", lock: "row exclusive" }]);
  });

  test("read a directive written without the space or indented as one", () => {
    const text = [
      inside,
      "create table t (id int8);",
      outside.replace("-- ottersql:", "--ottersql:"),
      `  -- ottersql:cleanup schema="public" index="i"`,
      "create index concurrently i on t (id);",
    ].join("\n");
    expect(
      readMigrationFile(text).map(({ transaction, statements }) => ({ transaction, statements })),
    ).toStrictEqual([
      { transaction: "inside", statements: ["create table t (id int8)"] },
      { transaction: "outside", statements: ["create index concurrently i on t (id)"] },
    ]);
  });

  test("take -- ottersql: inside a string for text, not a directive", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog(
        `${users}; comment on table users is 'x\n-- ottersql:cleanup schema="public" index="users_pkey"\ny'`,
      ),
    );
    expect(readMigrationFile(renderMigration(plan))).toStrictEqual(plan.steps.map(withoutReason));
  });

  test("read the same with Windows line endings", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog(`${users}; create index users_email on users (email)`),
    );
    const text = renderMigration(plan);
    expect(readMigrationFile(text.replaceAll("\n", "\r\n"))).toStrictEqual(readMigrationFile(text));
  });

  test("must be named by the time they were made, in UTC, and a lowercase name", async () => {
    const file = { name: "add-users.sql", text: `${inside}\nselect 1;` };
    await expect(pendingChanges([file], "")).rejects.toMatchObject({
      name: "MigrationFileError",
      message:
        "add-users.sql: the name must be YYYYMMDDHHMMSS_<name>.sql, the time in UTC and the name in lowercase letters, digits and underscores",
      file: "add-users.sql",
      line: null,
    });
  });

  test("that cannot be read are named, with the line, by what reads them", async () => {
    const file = { name: "20261025000000_hand.sql", text: "\ncreate table t (id int8);\n" };
    await expect(pendingChanges([file], "")).rejects.toMatchObject({
      name: "MigrationFileError",
      message: "20261025000000_hand.sql line 2: SQL must follow a -- ottersql:step line",
      file: "20261025000000_hand.sql",
      line: 2,
    });
  });

  test("may create extensions, which replaying them in PGlite loads", async () => {
    const file = {
      name: "20261025000000_emails.sql",
      text: [
        '-- ottersql:step kind=custom object="public.citext" phase=expand reversal=reversible lock="none"',
        "create extension citext;",
        '-- ottersql:step kind=createTable object="public.users" phase=expand reversal=lossy transaction=inside lock="none"',
        "create table users (email citext);",
      ].join("\n"),
    };
    await expect(
      pendingChanges([file], "create extension citext; create table users (email citext);"),
    ).resolves.toStrictEqual({ steps: [], manual: [] });
  });
});
