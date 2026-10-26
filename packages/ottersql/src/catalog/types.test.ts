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

describe("composite types", () => {
  test("reads a composite type's attributes in order, with their types and collations", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      create type app.pair as (left_side int4, label text collate "C");
      comment on type app.pair is 'Two values';
      create table t (p app.pair);
    `);
    expect({
      composites: catalog.composites,
      column: table(catalog, "t").columns[0]?.type,
    }).toStrictEqual({
      composites: [
        {
          schema: "app",
          name: "pair",
          attributes: [
            {
              name: "left_side",
              type: { kind: "base", schema: "pg_catalog", name: "int4" },
              typeSql: "integer",
              collation: null,
              comment: null,
            },
            {
              name: "label",
              type: { kind: "base", schema: "pg_catalog", name: "text" },
              typeSql: "text",
              collation: { schema: "pg_catalog", name: "C" },
              comment: null,
            },
          ],
          comment: { text: "Two values", annotations: [] },
        },
      ],
      column: { kind: "composite", schema: "app", name: "pair" },
    });
  });

  test("leaves out the row types tables, views and sequences have", async () => {
    const catalog = await loadCatalog(
      "create table t (id int8); create view v as select 1 as one;",
    );
    expect(catalog.composites).toStrictEqual([]);
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
  test("reads whether a domain's default calls a volatile function", async () => {
    const catalog = await loadCatalog(`
      create sequence tickets;
      create domain ticket as int8 default nextval('tickets');
    `);
    expect(catalog.domains.map(({ default: value }) => value)).toStrictEqual([
      { expression: "nextval('tickets'::regclass)", volatile: true },
    ]);
  });

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
        default: { expression: "'unknown@example.com'::character varying", volatile: false },
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

describe("search_path", () => {
  test("names what lies outside public with its schema, whatever search_path schema.sql sets", async () => {
    const catalog = await loadCatalog(`
      create schema app;
      set search_path = app;
      create type mood as enum ('sad', 'ok');
      create table t (m mood default 'ok' check (m <> 'sad'), n int4);
    `);
    const moods = table(catalog, "t", "app");
    expect({
      types: moods.columns.map((column) => column.typeSql),
      value: moods.columns[0]?.value,
      check: moods.checks[0]?.expression,
    }).toStrictEqual({
      types: ["app.mood", "integer"],
      value: { kind: "default", expression: "'ok'::app.mood", volatile: false },
      check: "(m <> 'sad'::app.mood)",
    });
  });
});
