import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("indexes", () => {
  test("reads keys, order, operator classes, collations, included columns and predicates", async () => {
    const catalog = await loadCatalog(`
      create table t (a int, b text, c text, d int);
      create index t_mix on t (a desc nulls last, lower(b) collate "C" text_pattern_ops, c nulls first)
        include (d) where a > 0;
    `);
    expect(table(catalog, "t").indexes).toStrictEqual([
      {
        name: "t_mix",
        method: "btree",
        unique: false,
        nullsNotDistinct: false,
        keys: [
          {
            kind: "column",
            column: "a",
            order: "desc",
            nulls: "last",
            operatorClass: null,
            collation: null,
          },
          {
            kind: "expression",
            expression: "lower(b)",
            order: "asc",
            nulls: "last",
            operatorClass: { schema: "pg_catalog", name: "text_pattern_ops" },
            collation: { schema: "pg_catalog", name: "C" },
          },
          {
            kind: "column",
            column: "c",
            order: "asc",
            nulls: "first",
            operatorClass: null,
            collation: null,
          },
        ],
        include: ["d"],
        predicate: "(a > 0)",
      },
    ]);
  });

  test("reads unique indexes and their methods, but not the indexes behind constraints", async () => {
    const catalog = await loadCatalog(`
      create table t (a int primary key, b text unique, c text collate "C");
      create unique index t_c on t (c) nulls not distinct;
      create index t_a_hash on t using hash (a);
    `);
    expect(
      table(catalog, "t").indexes.map(({ name, method, unique, nullsNotDistinct, keys }) => ({
        name,
        method,
        unique,
        nullsNotDistinct,
        collation: keys[0]?.collation,
      })),
    ).toStrictEqual([
      { name: "t_a_hash", method: "hash", unique: false, nullsNotDistinct: false, collation: null },
      { name: "t_c", method: "btree", unique: true, nullsNotDistinct: true, collation: null },
    ]);
  });

  test("keeps a unique index that a foreign key references", async () => {
    const catalog = await loadCatalog(`
      create table parent (code text);
      create unique index parent_code on parent (code);
      create table child (code text references parent (code));
    `);
    expect(table(catalog, "parent").indexes.map((index) => index.name)).toStrictEqual([
      "parent_code",
    ]);
  });

  test("keeps the index behind an exclusion constraint", async () => {
    const catalog = await loadCatalog(`
      create table booking (room int, during tsrange, exclude using gist (during with &&));
    `);
    expect(
      table(catalog, "booking").indexes.map(({ name, method }) => ({ name, method })),
    ).toStrictEqual([{ name: "booking_during_excl", method: "gist" }]);
  });
});
