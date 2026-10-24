import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("enums", () => {
  test("reads enums with their values in declared order", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      create type app.mood as enum ('sad', 'ok', 'happy');
      alter type app.mood add value 'meh' before 'ok';
      create type public.size as enum ();
    `);
    expect(catalog.enums).toStrictEqual([
      { schema: "app", name: "mood", values: ["sad", "meh", "ok", "happy"], comment: null },
      { schema: "public", name: "size", values: [], comment: null },
    ]);
  });

  test("refers to an enum column's type by its kind and name", async () => {
    const catalog = await loadCatalog(`
      create type mood as enum ('sad', 'happy');
      create table t (current mood, history mood[]);
    `);
    expect(table(catalog, "t").columns.map((column) => column.type)).toStrictEqual([
      { kind: "enum", schema: "public", name: "mood" },
      { kind: "array", element: { kind: "enum", schema: "public", name: "mood" } },
    ]);
  });
});

describe("vectors", () => {
  test("refers to int2vector and oidvector as base types, since their text is not an array", async () => {
    const catalog = await loadCatalog("create table t (a int2vector, b oidvector);");
    expect(table(catalog, "t").columns.map((column) => column.type)).toStrictEqual([
      { kind: "base", schema: "pg_catalog", name: "int2vector" },
      { kind: "base", schema: "pg_catalog", name: "oidvector" },
    ]);
  });
});

describe("ranges", () => {
  test("reads a range type's subtype and the multirange that goes with it", async () => {
    const catalog = await loadCatalog(`
      create type floatrange as range (subtype = float8);
    `);
    expect(catalog.ranges).toStrictEqual([
      {
        schema: "public",
        name: "floatrange",
        multirange: "floatmultirange",
        subtype: { kind: "base", schema: "pg_catalog", name: "float8" },
        comment: null,
      },
    ]);
  });
});

describe("domains", () => {
  test("reads a domain's base type, nullability, default and checks", async () => {
    const catalog = await loadCatalog(`
      create domain email as varchar(320) not null default 'unknown@example.com'
        constraint email_has_at check (value like '%@%');
      create domain level as text check (value in ('low', 'high'));
    `);
    expect(catalog.domains).toStrictEqual([
      {
        schema: "public",
        name: "email",
        baseType: { kind: "base", schema: "pg_catalog", name: "varchar" },
        baseTypeSql: "character varying(320)",
        notNull: true,
        default: "'unknown@example.com'::character varying",
        checks: [
          {
            name: "email_has_at",
            expression: "((VALUE)::text ~~ '%@%'::text)",
            allowedValues: null,
            enforcement: "validated",
          },
        ],
        comment: null,
      },
      {
        schema: "public",
        name: "level",
        baseType: { kind: "base", schema: "pg_catalog", name: "text" },
        baseTypeSql: "text",
        notNull: false,
        default: null,
        checks: [
          {
            name: "level_check",
            expression: "(VALUE = ANY (ARRAY['low'::text, 'high'::text]))",
            allowedValues: ["low", "high"],
            enforcement: "validated",
          },
        ],
        comment: null,
      },
    ]);
  });

  test("leaves out the domains of system schemas", async () => {
    const catalog = await loadCatalog("");
    expect(catalog.domains).toStrictEqual([]);
  });
});
