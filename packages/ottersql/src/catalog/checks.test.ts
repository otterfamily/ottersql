import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("check constraints", () => {
  test("reads the expression, columns and enforcement of a check", async () => {
    const catalog = await loadCatalog(`
      create table t (a int, b int, constraint t_order check (a < b));
      alter table t add constraint t_positive check (a > 0) not valid;
    `);
    expect(table(catalog, "t").checks).toStrictEqual([
      {
        name: "t_order",
        expression: "(a < b)",
        columns: ["a", "b"],
        allowedValues: null,
        notNullColumns: [],
        noInherit: false,
        enforcement: "validated",
      },
      {
        name: "t_positive",
        expression: "(a > 0)",
        columns: ["a"],
        allowedValues: null,
        notNullColumns: [],
        noInherit: false,
        enforcement: "not valid",
      },
    ]);
  });

  test.each([
    { column: "a text check (a in ('x', 'it''s'))", values: ["x", "it's"] },
    { column: "a varchar(10) check (a in ('x', 'y'))", values: ["x", "y"] },
    { column: "a text check (a in ('only'))", values: ["only"] },
    { column: "a text check (a in ('x, ''y', 'z'))", values: ["x, 'y", "z"] },
    { column: `"A b" text check ("A b" in ('x'))`, values: ["x"] },
  ])("reads $values as the values allowed by $column", async ({ column, values }) => {
    const catalog = await loadCatalog(`create table t (${column});`);
    const [check] = table(catalog, "t").checks;
    expect(check?.allowedValues).toStrictEqual({ column: check?.columns[0], values });
  });

  test.each([
    "a int check (a in (1, 2))",
    "a text check (a is not null and a in ('x'))",
    "a text check (length(a) < 5)",
  ])("recognises no allowed values in %s", async (column) => {
    const catalog = await loadCatalog(`create table t (${column});`);
    const [check] = table(catalog, "t").checks;
    expect(check?.allowedValues).toBeNull();
  });

  test("recognises no allowed values in a check that does not hold for every row", async () => {
    const catalog = await loadCatalog(`
      create table t (a text, b text constraint t_b_check check (b in ('x')) not enforced);
      alter table t add constraint t_a_check check (a in ('x')) not valid;
    `);
    expect(
      table(catalog, "t").checks.map(({ name, allowedValues }) => ({ name, allowedValues })),
    ).toStrictEqual([
      { name: "t_a_check", allowedValues: null },
      { name: "t_b_check", allowedValues: null },
    ]);
  });

  test.each([
    { check: "a is not null", columns: ["a"] },
    { check: `"A b" is not null`, columns: ["A b"] },
    { check: "a is not null and b > 0", columns: ["a"] },
    { check: "a is not null and b is not null", columns: ["a", "b"] },
    { check: "a is not null and (b > 0 or c = ' AND (c IS NOT NULL)')", columns: ["a"] },
    { check: "a is not null or b is not null", columns: [] },
    { check: "(a + b) is not null", columns: [] },
    { check: "not (a is null)", columns: [] },
  ])("proves $columns non-null by check ($check)", async ({ check, columns }) => {
    const catalog = await loadCatalog(
      `create table t (a int, "A b" int, b int, c text, check (${check}));`,
    );
    expect(table(catalog, "t").checks[0]?.notNullColumns).toStrictEqual(columns);
  });

  test("proves no column non-null by a check that does not hold for every row", async () => {
    const catalog = await loadCatalog(`
      create table t (a int, b int check (b is not null) not enforced);
      alter table t add constraint t_a check (a is not null) not valid;
    `);
    expect(table(catalog, "t").checks.flatMap((check) => check.notNullColumns)).toStrictEqual([]);
  });
});
