import { describe, expect, test as base } from "vitest";

import { rawQuery } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { QueryError } from "./query-error.ts";
import { openDrivers } from "./test-drivers.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

/** Statements Postgres rejects on the table `t`, and what every driver must report. */
const failures = [
  {
    name: "a unique violation",
    sql: "insert into t (email, age) values ('otter@example.com', 1), ('otter@example.com', 2)",
    expected: {
      code: "23505",
      schema: "public",
      table: "t",
      column: null,
      constraint: "t_email_key",
      detail: "Key (email)=(otter@example.com) already exists.",
    },
  },
  {
    name: "a not-null violation",
    sql: "insert into t (email, age) values (null, 1)",
    expected: { code: "23502", schema: "public", table: "t", column: "email", constraint: null },
  },
  {
    name: "a check violation",
    sql: "insert into t (email, age) values ('young@example.com', -1)",
    expected: {
      code: "23514",
      schema: "public",
      table: "t",
      column: null,
      constraint: "t_age_check",
    },
  },
  {
    name: "a syntax error",
    sql: "selec 1",
    expected: { code: "42601", schema: null, table: null, column: null, constraint: null },
  },
  {
    name: "a division by zero",
    sql: "select 1 / 0",
    expected: { code: "22012", schema: null, table: null, column: null, constraint: null },
  },
];

describe("errors Postgres reports", () => {
  test.for(failures)(
    "reject with the same QueryError on every driver for $name",
    async ({ sql, expected }, { drivers }) => {
      for (const connection of drivers) {
        await rawQuery(connection, "drop table if exists t", []);
        await rawQuery(
          connection,
          "create table t (email text not null unique, age int4 not null check (age >= 0))",
          [],
        );
        const failure = rawQuery(connection, sql, []);
        await expect(failure).rejects.toBeInstanceOf(QueryError);
        await expect(failure).rejects.toMatchObject(expected);
        await expect(failure).rejects.toHaveProperty("cause");
      }
    },
  );
});
