import { describe, expect, test } from "vitest";

import { loadCatalog, openSchema } from "./index.ts";

describe("extensions in schema.sql", () => {
  test("load the extensions PGlite ships, when the schema creates them", async () => {
    const catalog = await loadCatalog(`
      create extension citext;
      create extension "uuid-ossp";
      create table users (id uuid primary key default uuid_generate_v4(), email citext not null);
    `);
    expect(catalog.tables[0]?.columns.map(({ name, type }) => ({ name, type }))).toStrictEqual([
      { name: "id", type: { kind: "base", schema: "pg_catalog", name: "uuid" } },
      { name: "email", type: { kind: "base", schema: "public", name: "citext" } },
    ]);
  });

  test("load pgvector when its PGlite package is installed", async () => {
    const catalog = await loadCatalog(
      "create extension vector; create table items (id int8, embedding vector(3))",
    );
    expect(catalog.tables[0]?.columns.map(({ typeSql }) => typeSql)).toStrictEqual([
      "bigint",
      "vector(3)",
    ]);
  });

  test("skip creating an extension PGlite lacks when nothing in the schema uses it", async () => {
    const catalog = await loadCatalog(
      "create extension if not exists pgaudit; create table logs (id int8)",
    );
    expect(catalog.tables.map(({ name }) => name)).toStrictEqual(["logs"]);
  });

  test("name the extension PGlite lacks when the schema uses it", async () => {
    await expect(
      loadCatalog("create extension postgis;\ncreate table places (spot geometry)"),
    ).rejects.toMatchObject({
      name: "SchemaError",
      message:
        'type "geometry" does not exist; PGlite has no extension postgis, so ottersql skipped creating it',
      position: { line: 2, column: 27 },
    });
  });

  test("load the extensions of SQL run after the schema too", async () => {
    const schema = await openSchema("", { alsoRuns: ["create extension pg_trgm"] });
    try {
      await schema.run("create extension pg_trgm; create table words (word text)");
      await schema.run("create index words_trgm on words using gin (word gin_trgm_ops)");
      const catalog = await schema.readCatalog();
      expect(
        catalog.tables[0]?.indexes.map(({ name, method }) => ({ name, method })),
      ).toStrictEqual([{ name: "words_trgm", method: "gin" }]);
    } finally {
      await schema.close();
    }
  });
});
