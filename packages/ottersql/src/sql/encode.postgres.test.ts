import { describe, expect, test as base } from "vitest";

import { defineQuery, json } from "./index.ts";
import type { Connection } from "./index.ts";
import { openDrivers } from "./test-drivers.ts";
import { errorChainText } from "./test-errors.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

describe("encoding parameters", () => {
  test.for([
    ["date", Temporal.PlainDate.from("+010000-01-01")],
    ["date", Temporal.PlainDate.from("-000043-03-15")],
    ["date", Temporal.PlainDate.from("0000-06-01")],
    ["timestamp", Temporal.PlainDateTime.from("-000043-03-15T12:30:00.5")],
    ["timestamptz", Temporal.Instant.from("+010000-01-01T00:00:00Z")],
    ["timestamptz", Temporal.Instant.from("-000043-03-15T00:00:00.000001Z")],
  ] as const)(
    "sends a %s in a year ISO 8601 writes with a sign: %s",
    async ([type, value], { drivers }) => {
      const roundTrip = defineQuery(`select $1::${type} as v`, ["v"]);
      for (const connection of drivers) {
        await expect(roundTrip.one(connection, { v: value })).resolves.toStrictEqual({ v: value });
      }
    },
  );

  test("rejects a value it cannot send, naming its kind but not its text", async ({ drivers }) => {
    const secret = "4111 1111 1111 1111";
    const card = { toString: () => secret };
    for (const connection of drivers) {
      const rejected = defineQuery("select $1::text", ["v"])(connection, { v: card });
      await expect(rejected).rejects.toThrow(
        new TypeError("cannot send an Object as a Postgres parameter"),
      );
      await expect(rejected.catch(errorChainText)).resolves.not.toContain(secret);
    }
  });

  test.for<readonly [string, string, unknown, unknown]>([
    ["int8 from a number", "int8", 42, "42"],
    ["int8 from a bigint", "int8", 9_223_372_036_854_775_807n, "9223372036854775807"],
    ["bool", "bool", false, false],
    ["date", "date", Temporal.PlainDate.from("2000-02-29"), Temporal.PlainDate.from("2000-02-29")],
    [
      "timestamptz",
      "timestamptz",
      Temporal.Instant.from("2000-01-01T00:00:00.000001Z"),
      Temporal.Instant.from("2000-01-01T00:00:00.000001Z"),
    ],
    [
      "interval",
      "interval",
      { months: 1, days: -2, microseconds: 3n },
      { months: 1, days: -2, microseconds: 3n },
    ],
    ["bytea", "bytea", new Uint8Array([1, 2, 255]), new Uint8Array([1, 2, 255])],
    ["text array", "text[]", ["a,b", 'c"d', "", null], ["a,b", 'c"d', "", null]],
    ["jsonb", "jsonb", json({ a: ["x", 1] }), { a: ["x", 1] }],
    ["jsonb string", "jsonb", json("x"), "x"],
    [
      "range",
      "int4range",
      { lower: 1, upper: null, lowerInclusive: true, upperInclusive: false },
      { lower: 1, upper: null, lowerInclusive: true, upperInclusive: false },
    ],
    ["null", "text", null, null],
  ])("round-trips %s", async ([, type, value, expected], { drivers }) => {
    for (const connection of drivers) {
      const echo = defineQuery(`select $1::${type} as v`, ["value"]);
      await expect(echo.one(connection, { value })).resolves.toStrictEqual({ v: expected });
    }
  });
});

describe("rows", () => {
  test.for([
    [
      'select 1 as "__proto__"',
      'Column "__proto__" cannot be a property of a row; rename it with AS',
    ],
    [
      "select 1 as a, 2 as a",
      'Column "a" appears more than once; give each column its own name with AS',
    ],
  ] as const)("reject columns they cannot hold: %s", async ([sql, message], { drivers }) => {
    for (const connection of drivers) {
      await expect(defineQuery(sql, [])(connection)).rejects.toThrow(message);
    }
  });
});

describe("parameters", () => {
  test.for([
    ["a missing parameter", {}, "a"],
    ["an undefined parameter", { a: undefined }, "a"],
    ["a parameter named after an Object method", {}, "toString"],
  ] as const)("reject %s rather than sending NULL", async ([, params, name], { drivers }) => {
    for (const connection of drivers) {
      await expect(defineQuery(`select $1::text as v`, [name])(connection, params)).rejects.toThrow(
        `Parameter "${name}" is missing; pass null for NULL`,
      );
    }
  });
});
