import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("table settings", () => {
  test("reads how a table is partitioned, and the bounds of its partitions", async () => {
    const catalog = await loadCatalog(`
      create table events (id int8, at date) partition by range (at);
      create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
      create table plain (id int8);
    `);
    expect(
      ["events", "events_2026", "plain"].map((name) => {
        const { partitionedBy, partitionOf } = table(catalog, name);
        return { partitionedBy, partitionOf };
      }),
    ).toStrictEqual([
      { partitionedBy: "RANGE (at)", partitionOf: null },
      {
        partitionedBy: null,
        partitionOf: {
          schema: "public",
          table: "events",
          bound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        },
      },
      { partitionedBy: null, partitionOf: null },
    ]);
  });

  test("reads the tables a table inherits from, in order, leaving partitions to partitionOf", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      create table app.base (id int8);
      create table stamped (at date);
      create table child (note text) inherits (app.base, stamped);
      create table events (id int8, at date) partition by range (at);
      create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
    `);
    expect(
      ["child", "stamped", "events_2026"].map((name) => table(catalog, name).inherits),
    ).toStrictEqual([
      [
        { schema: "app", name: "base" },
        { schema: "public", name: "stamped" },
      ],
      [],
      [],
    ]);
  });

  test("reads a column's storage and compression where they are not its type's default", async () => {
    const catalog = await loadCatalog(
      "create table t (a text, b text storage external compression pglz, c int4 storage plain)",
    );
    expect(
      table(catalog, "t").columns.map(({ name, storage, compression }) => ({
        name,
        storage,
        compression,
      })),
    ).toStrictEqual([
      { name: "a", storage: null, compression: null },
      { name: "b", storage: "external", compression: "pglz" },
      { name: "c", storage: null, compression: null },
    ]);
  });

  test("reads whether a table is unlogged, and the storage parameters of tables and indexes", async () => {
    const catalog = await loadCatalog(`
      create unlogged table scratch (a int4);
      create table kept (a int4) with (fillfactor = 70, autovacuum_enabled = false);
      create index kept_a on kept (a) with (fillfactor = 50);
    `);
    expect({
      scratch: [table(catalog, "scratch").unlogged, table(catalog, "scratch").options],
      kept: [table(catalog, "kept").unlogged, table(catalog, "kept").options],
      index: table(catalog, "kept").indexes.map((index) => index.options),
    }).toStrictEqual({
      scratch: [true, []],
      kept: [false, ["fillfactor=70", "autovacuum_enabled=false"]],
      index: [["fillfactor=50"]],
    });
  });
});
