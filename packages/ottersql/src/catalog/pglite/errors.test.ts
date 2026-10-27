import { describe, expect, test } from "vitest";

import { loadCatalog, SchemaError } from "../index.ts";

async function schemaError(schemaSql: string): Promise<SchemaError> {
  const rejection: unknown = await loadCatalog(schemaSql).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(rejection instanceof SchemaError)) {
    throw new TypeError(`expected a SchemaError, got ${String(rejection)}`);
  }
  return rejection;
}

describe("schema errors, at columns counted in UTF-16 code units as tsc counts them", () => {
  test.each([
    {
      schemaSql: "create table a (id int);\n\ncreate table b (id int, oops);",
      code: "42601",
      message: 'syntax error at or near ")"',
      position: { line: 3, column: 29 },
    },
    {
      schemaSql: "create table a (id int);\ncreate view v as select missing from a;",
      code: "42703",
      message: 'column "missing" does not exist',
      position: { line: 2, column: 25 },
    },
    {
      schemaSql: "create table é (id int);\ncreate view v as select é.nope from é;",
      code: "42703",
      message: "column é.nope does not exist",
      position: { line: 2, column: 25 },
    },
    {
      schemaSql: 'create table "🦦" (id int);\ncreate view v as select "🦦".id, nope from "🦦";',
      code: "42703",
      message: 'column "nope" does not exist',
      position: { line: 2, column: 34 },
    },
    {
      schemaSql: "create table a (id int);\ncreate index on a (missing);",
      code: "42703",
      message: 'column "missing" does not exist',
      position: null,
    },
    {
      schemaSql: "create table b (id int references missing (id));",
      code: "42P01",
      message: 'relation "missing" does not exist',
      position: null,
    },
  ])("reports $message at $position", async ({ schemaSql, code, message, position }) => {
    const error = await schemaError(schemaSql);
    expect({ code: error.code, message: error.message, position: error.position }).toStrictEqual({
      code,
      message,
      position,
    });
  });
});
