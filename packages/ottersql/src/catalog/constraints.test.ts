import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("keys", () => {
  test("reads a composite primary key in key order", async () => {
    const catalog = await loadCatalog(`create table t (a int, b int, primary key (b, a));`);
    expect(table(catalog, "t").primaryKey).toStrictEqual({
      name: "t_pkey",
      columns: ["b", "a"],
      include: [],
      withoutOverlaps: false,
      deferral: "not deferrable",
    });
  });

  test("has no primary key when the table declares none", async () => {
    const catalog = await loadCatalog(`create table t (a int);`);
    expect(table(catalog, "t").primaryKey).toBeNull();
  });

  test("reads unique constraints with their columns, null handling and deferral", async () => {
    const catalog = await loadCatalog(`
      create table t (
        a int, b int, c int,
        constraint t_b_a_key unique (b, a),
        constraint t_c_key unique nulls not distinct (c) deferrable initially deferred
      );
    `);
    expect(table(catalog, "t").uniqueConstraints).toStrictEqual([
      {
        name: "t_b_a_key",
        columns: ["b", "a"],
        include: [],
        nullsNotDistinct: false,
        withoutOverlaps: false,
        deferral: "not deferrable",
      },
      {
        name: "t_c_key",
        columns: ["c"],
        include: [],
        nullsNotDistinct: true,
        withoutOverlaps: false,
        deferral: "initially deferred",
      },
    ]);
  });

  test("reads composite foreign keys with their actions, match type and state", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      create table app.parent (x int, y int, primary key (x, y));
      create table child (
        px int, py int,
        constraint child_parent_fkey foreign key (px, py) references app.parent (x, y)
          match full on update cascade on delete set null deferrable,
        constraint child_loose_fkey foreign key (px, py) references app.parent (x, y) not enforced
      );
      alter table child add constraint child_lazy_fkey
        foreign key (px, py) references app.parent (x, y) not valid;
    `);
    expect(table(catalog, "child").foreignKeys).toStrictEqual([
      {
        name: "child_lazy_fkey",
        columns: ["px", "py"],
        references: { schema: "app", table: "parent", columns: ["x", "y"] },
        match: "simple",
        onUpdate: "no action",
        onDelete: "no action",
        onDeleteColumns: [],
        period: false,
        deferral: "not deferrable",
        enforcement: "not valid",
      },
      {
        name: "child_loose_fkey",
        columns: ["px", "py"],
        references: { schema: "app", table: "parent", columns: ["x", "y"] },
        match: "simple",
        onUpdate: "no action",
        onDelete: "no action",
        onDeleteColumns: [],
        period: false,
        deferral: "not deferrable",
        enforcement: "not enforced",
      },
      {
        name: "child_parent_fkey",
        columns: ["px", "py"],
        references: { schema: "app", table: "parent", columns: ["x", "y"] },
        match: "full",
        onUpdate: "cascade",
        onDelete: "set null",
        onDeleteColumns: [],
        period: false,
        deferral: "initially immediate",
        enforcement: "validated",
      },
    ]);
  });

  test("reads included columns and deferral of primary keys and unique constraints", async () => {
    const catalog = await loadCatalog(`
      create table t (
        a int, b int, c int, d int,
        constraint t_pkey primary key (a) include (b) deferrable initially deferred,
        constraint t_c_key unique (c) include (d, b)
      );
    `);
    expect([table(catalog, "t").primaryKey, table(catalog, "t").uniqueConstraints]).toStrictEqual([
      {
        name: "t_pkey",
        columns: ["a"],
        include: ["b"],
        withoutOverlaps: false,
        deferral: "initially deferred",
      },
      [
        {
          name: "t_c_key",
          columns: ["c"],
          include: ["d", "b"],
          nullsNotDistinct: false,
          withoutOverlaps: false,
          deferral: "not deferrable",
        },
      ],
    ]);
  });

  test("reads the columns ON DELETE SET NULL or SET DEFAULT sets, when it names them", async () => {
    const catalog = await loadCatalog(`
      create table parent (tenant int, id int, primary key (tenant, id));
      create table child (
        tenant int, parent_id int,
        foreign key (tenant, parent_id) references parent on delete set null (parent_id)
      );
    `);
    expect(
      table(catalog, "child").foreignKeys.map(({ onDelete, onDeleteColumns }) => ({
        onDelete,
        onDeleteColumns,
      })),
    ).toStrictEqual([{ onDelete: "set null", onDeleteColumns: ["parent_id"] }]);
  });

  test("reads keys WITHOUT OVERLAPS and foreign keys with PERIOD", async () => {
    const catalog = await loadCatalog(`
      create extension btree_gist;
      create table room (id int8, during tstzrange, primary key (id, during without overlaps));
      create table booking (
        room_id int8, at tstzrange, unique (room_id, at without overlaps),
        foreign key (room_id, period at) references room (id, period during)
      );
    `);
    expect({
      primaryKey: table(catalog, "room").primaryKey?.withoutOverlaps,
      unique: table(catalog, "booking").uniqueConstraints.map((key) => key.withoutOverlaps),
      foreignKey: table(catalog, "booking").foreignKeys.map((key) => key.period),
    }).toStrictEqual({ primaryKey: true, unique: [true], foreignKey: [true] });
  });
});

describe("exclusion constraints", () => {
  test("reads them as Postgres prints them, without the index behind them", async () => {
    const catalog = await loadCatalog(`
      create table booking (
        room int, during tsrange,
        constraint no_overlap exclude using gist (during with &&) deferrable initially deferred
      );
    `);
    expect({
      exclusionConstraints: table(catalog, "booking").exclusionConstraints,
      indexes: table(catalog, "booking").indexes,
    }).toStrictEqual({
      exclusionConstraints: [
        {
          name: "no_overlap",
          definition: "EXCLUDE USING gist (during WITH &&) DEFERRABLE INITIALLY DEFERRED",
        },
      ],
      indexes: [],
    });
  });
});
