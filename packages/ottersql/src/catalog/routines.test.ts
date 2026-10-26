import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import type { Catalog, RoutineArgument, Routine } from "./index.ts";

const int4 = { kind: "base", schema: "pg_catalog", name: "int4" } as const;
const text = { kind: "base", schema: "pg_catalog", name: "text" } as const;

function routine(catalog: Catalog, name: string): Routine {
  const found = catalog.routines.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`routine ${name} not in catalog`);
  }
  return found;
}

function input(name: string, hasDefault = false): RoutineArgument {
  return { name, mode: "in", type: int4, typeSql: "integer", hasDefault };
}

describe("routines", () => {
  test("reads a scalar function's arguments, defaults, result, volatility and body", async () => {
    const catalog = await loadCatalog(`
      create function add(a int, b int default 1) returns int
        language sql immutable as 'select a + b';
      comment on function add is 'Adds';
    `);
    expect(routine(catalog, "add")).toStrictEqual({
      schema: "public",
      name: "add",
      kind: "function",
      arguments: [input("a"), input("b", true)],
      returns: { kind: "value", setOf: false, type: int4, typeSql: "integer" },
      volatility: "immutable",
      definition: "select a + b",
      comment: { text: "Adds", annotations: [] },
    });
  });

  test("reads no body of a SQL-standard function, which Postgres keeps only parsed, nor of an aggregate", async () => {
    const catalog = await loadCatalog(`
      create function twice(n int) returns int language sql immutable return n * 2;
      create aggregate total(int) (sfunc = int4pl, stype = int);
    `);
    expect([
      routine(catalog, "twice").definition,
      routine(catalog, "total").definition,
    ]).toStrictEqual([null, null]);
  });

  test("reads OUT, INOUT and TABLE parameters as the columns of the rows it returns", async () => {
    const catalog = await loadCatalog(`
      create function pairs(out x int, inout y text) returns setof record
        language sql as 'select 1, y';
      create function tab(n int) returns table (id int, label text)
        language sql stable as 'select n, ''a''';
    `);
    expect([routine(catalog, "pairs"), routine(catalog, "tab")]).toMatchObject([
      {
        arguments: [{ name: "y", mode: "inout", type: text, typeSql: "text", hasDefault: false }],
        returns: {
          kind: "row",
          setOf: true,
          columns: [
            { name: "x", type: int4, typeSql: "integer" },
            { name: "y", type: text, typeSql: "text" },
          ],
        },
        volatility: "volatile",
      },
      {
        arguments: [input("n")],
        returns: {
          kind: "row",
          setOf: true,
          columns: [
            { name: "id", type: int4, typeSql: "integer" },
            { name: "label", type: text, typeSql: "text" },
          ],
        },
        volatility: "stable",
      },
    ]);
  });

  test("reads procedures as returning nothing and variadic arguments by their mode", async () => {
    const catalog = await loadCatalog(`
      create procedure log_it(a int) language sql as 'select 1';
      create function total(variadic xs int[]) returns int language sql as 'select 1';
    `);
    expect([routine(catalog, "log_it"), routine(catalog, "total")]).toMatchObject([
      { kind: "procedure", arguments: [input("a")], returns: { kind: "none" } },
      {
        kind: "function",
        arguments: [
          {
            name: "xs",
            mode: "variadic",
            type: { kind: "array", element: int4 },
            typeSql: "integer[]",
            hasDefault: false,
          },
        ],
      },
    ]);
  });

  test("reads a procedure's OUT and INOUT parameters as arguments and as the row it returns", async () => {
    const catalog = await loadCatalog(`
      create procedure swap(inout x int, out y int) language sql as 'select x, x';
    `);
    expect(routine(catalog, "swap")).toMatchObject({
      kind: "procedure",
      arguments: [
        { name: "x", mode: "inout", type: int4, typeSql: "integer", hasDefault: false },
        { name: "y", mode: "out", type: int4, typeSql: "integer", hasDefault: false },
      ],
      returns: {
        kind: "row",
        setOf: false,
        columns: [
          { name: "x", type: int4, typeSql: "integer" },
          { name: "y", type: int4, typeSql: "integer" },
        ],
      },
    });
  });
});
