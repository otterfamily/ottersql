import { describe, expect, test } from "vitest";

import { nextMigrationName } from "../index.ts";

const now = new Date("2026-10-25T12:34:56Z");

describe("nextMigrationName", () => {
  test.for([
    { situation: "no migrations yet", existing: [], name: "20261025123456_add_users.sql" },
    {
      situation: "the newest made in the same second",
      existing: ["20261025123456_first.sql"],
      name: "20261025123457_add_users.sql",
    },
    {
      situation: "the newest made on a clock ahead of this one",
      existing: ["20261025130000_first.sql"],
      name: "20261025130001_add_users.sql",
    },
    {
      situation: "older migrations only",
      existing: ["20261024000000_first.sql"],
      name: "20261025123456_add_users.sql",
    },
  ])("names the next migration by UTC time, after $situation", ({ existing, name }) => {
    expect(nextMigrationName(existing, "add_users", now)).toBe(name);
  });

  test("refuses a name that is not lowercase letters, digits and underscores", () => {
    expect(() => nextMigrationName([], "Add Users", now)).toThrow(
      new RangeError(
        'A migration name is lowercase letters, digits and underscores, not "Add Users"',
      ),
    );
  });
});
