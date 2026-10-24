import { describe, expect, test } from "vitest";
import { loadCatalog, type Catalog, type Table } from "./index.ts";

function table(catalog: Catalog, name: string, schema = "public"): Table {
  const found = catalog.tables.find((t) => t.schema === schema && t.name === name);
  if (found === undefined) throw new Error(`table ${schema}.${name} not in catalog`);
  return found;
}

describe("tables", () => {
  test("lists user tables in schema then name order, without system tables", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      create table public.b (id int);
      create table app.z (id int);
      create table public.a (id int);
    `);
    expect(catalog.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "app.z",
      "public.a",
      "public.b",
    ]);
  });

  test("reads columns in definition order with their type and nullability", async () => {
    const catalog = await loadCatalog(`
      create table users (
        id int8 not null,
        name varchar(20),
        tags text[] not null,
        balance numeric(10, 2)
      );
    `);
    expect(table(catalog, "users").columns).toEqual([
      expect.objectContaining({
        name: "id",
        type: { kind: "base", schema: "pg_catalog", name: "int8" },
        typeSql: "bigint",
        notNull: true,
      }),
      expect.objectContaining({
        name: "name",
        type: { kind: "base", schema: "pg_catalog", name: "varchar" },
        typeSql: "character varying(20)",
        notNull: false,
      }),
      expect.objectContaining({
        name: "tags",
        type: { kind: "array", element: { kind: "base", schema: "pg_catalog", name: "text" } },
        typeSql: "text[]",
        notNull: true,
      }),
      expect.objectContaining({
        name: "balance",
        type: { kind: "base", schema: "pg_catalog", name: "numeric" },
        typeSql: "numeric(10,2)",
        notNull: false,
      }),
    ]);
  });
});
