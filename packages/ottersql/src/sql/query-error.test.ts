import { describe, expect, test } from "vitest";

import { errorFieldsReader } from "./query-error.ts";

const read = errorFieldsReader((error) => error.name === "PostgresError", {
  code: "errno",
  schema: "schema_name",
  table: "table_name",
  column: "column_name",
  constraint: "constraint_name",
});

function postgresError(fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error("duplicate key"), { name: "PostgresError", ...fields });
}

describe("errorFieldsReader", () => {
  test("reads each field at the name the driver gives it", () => {
    const error = postgresError({
      errno: "23505",
      detail: "Key (email)=(otter@example.com) already exists.",
      schema_name: "public",
      table_name: "t",
      constraint_name: "t_email_key",
    });
    expect(read(error)).toStrictEqual({
      code: "23505",
      message: "duplicate key",
      detail: "Key (email)=(otter@example.com) already exists.",
      hint: null,
      schema: "public",
      table: "t",
      column: null,
      constraint: "t_email_key",
    });
  });

  test.for([
    { name: "a driver's own code", errno: "ECONNRESET" },
    { name: "a code of four characters", errno: "2350" },
    { name: "a code in lower case", errno: "42p01" },
    { name: "a code that is not a string", errno: 23_505 },
    { name: "no code", errno: undefined },
  ])("does not read an error with $name, which is not a SQLSTATE", ({ errno }) => {
    expect(read(postgresError({ errno }))).toBeNull();
  });

  test("does not read an error the driver did not take from Postgres", () => {
    const refused = Object.assign(new Error("refused"), { errno: "23505" });
    expect(read(refused)).toBeNull();
  });

  test("does not read a value that is not an Error", () => {
    expect(read({ name: "PostgresError", errno: "23505" })).toBeNull();
  });
});
