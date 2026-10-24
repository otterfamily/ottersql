import { loadCatalog } from "@ottersql/catalog";
import { describe, expect, test } from "vitest";

import { pendingChanges, planMigration, readMigrationFile, renderMigration } from "./index.ts";
import type { Step } from "./index.ts";
import { users } from "./test-migrate.ts";

/** Reasons are comments in the file, for reviewers; reading it back leaves them out. */
function withoutReason(step: Step): Step {
  return { ...step, reason: null };
}

describe("migration files", () => {
  test("read back the steps they were rendered from, so a plan survives review in a file", async () => {
    const plan = planMigration(
      await loadCatalog(users),
      await loadCatalog(
        "create table users (id int8 primary key, email text not null unique check (email <> 'a;b'))",
      ),
    );
    const steps = readMigrationFile(renderMigration(plan));
    expect(steps).toStrictEqual(plan.steps.map(withoutReason));
  });

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
  ])("reject $problem, naming the line", ({ text, message }) => {
    expect(() => readMigrationFile(text)).toThrow(message);
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
});
