import { describe, expect, test as base } from "vitest";

import { rawQuery } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { defineQuery } from "./query.ts";
import { openDrivers } from "./test-drivers.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

/** Statements on a table holding `a`, `b` and `c`, and the count each must report. */
const statements = [
  { sql: "insert into letters values ('d'), ('e')", count: 2 },
  { sql: "update letters set letter = upper(letter) where letter <> 'a'", count: 2 },
  { sql: "delete from letters where letter = 'z'", count: 0 },
  { sql: "delete from letters returning letter", count: 3 },
  { sql: "select letter from letters", count: 3 },
  {
    sql: "merge into letters using (values ('a'), ('q')) as v(letter) on letters.letter = v.letter when not matched then insert values (v.letter)",
    count: 1,
  },
];

describe("affected", () => {
  test.for(statements)(
    "counts the rows `$sql` writes or returns, on every driver",
    async ({ sql, count }, { drivers }) => {
      for (const connection of drivers) {
        await rawQuery(connection, "drop table if exists letters", []);
        await rawQuery(connection, "create table letters (letter text)", []);
        await rawQuery(connection, "insert into letters values ('a'), ('b'), ('c')", []);
        await expect(defineQuery(sql, []).affected(connection)).resolves.toBe(count);
      }
    },
  );
});
