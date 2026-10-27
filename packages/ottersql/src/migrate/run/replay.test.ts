import { describe, expect, test } from "vitest";

import { pendingChanges, renderMigration } from "../index.ts";
import { summary, users } from "../test-migrate.ts";

const usersWithName = "create table users (id int8 primary key, email text, name text)";

describe("pendingChanges", () => {
  test("plans everything from an empty history", async () => {
    const plan = await pendingChanges([], users);
    expect(plan.steps.map((step) => summary(step))).toStrictEqual([
      "expand createTable public.users (lossy, inside, none)",
    ]);
  });

  test("plans only what the migrations so far do not reach, replaying them in order", async () => {
    const first = {
      name: "20261025000000_users.sql",
      text: renderMigration(await pendingChanges([], users)),
    };
    const plan = await pendingChanges([first], usersWithName);
    expect(plan.steps.map((step) => summary(step))).toStrictEqual([
      "expand addColumn public.users.name (lossy, inside, access exclusive)",
    ]);
  });

  test("finds nothing when the migrations reach schema.sql", async () => {
    const first = {
      name: "20261025000000_users.sql",
      text: renderMigration(await pendingChanges([], users)),
    };
    await expect(pendingChanges([first], users)).resolves.toStrictEqual({ steps: [], manual: [] });
  });
});
