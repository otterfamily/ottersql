import { describe, expect, test as base } from "vitest";

import { defineQuery, json } from "./index.ts";
import type { Connection } from "./index.ts";
import { openDrivers } from "./test-drivers.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

async function selectOne(connection: Connection, expression: string): Promise<unknown> {
  const row = await defineQuery(`select ${expression} as v`, []).one(connection);
  return row["v"];
}

describe("decoding values (ADR 0008)", () => {
  test.for<readonly [string, string, unknown]>([
    ["int2", "12::int2", 12],
    ["int4", "-7::int4", -7],
    ["int8 stays exact", "9223372036854775807::int8", "9223372036854775807"],
    ["count(*) is int8", "(select count(*) from (values (1), (2)) v)", "2"],
    ["numeric stays exact", "1.10::numeric", "1.10"],
    ["float8", "1.5::float8", 1.5],
    ["float8 NaN", "'NaN'::float8", Number.NaN],
    ["float8 infinity", "'-Infinity'::float8", Number.NEGATIVE_INFINITY],
    ["bool", "true", true],
    ["text", "'it''s'::text", "it's"],
    [
      "uuid",
      "'00000000-0000-0000-0000-000000000001'::uuid",
      "00000000-0000-0000-0000-000000000001",
    ],
    ["date", "'2000-02-29'::date", Temporal.PlainDate.from("2000-02-29")],
    ["date BC", "'0044-03-15 BC'::date", Temporal.PlainDate.from("-000043-03-15")],
    [
      "timestamp",
      "'2000-01-02 03:04:05.123456'::timestamp",
      Temporal.PlainDateTime.from("2000-01-02T03:04:05.123456"),
    ],
    [
      "timestamptz",
      "'2000-01-02 03:04:05.5+09'::timestamptz",
      Temporal.Instant.from("2000-01-01T18:04:05.5Z"),
    ],
    [
      "timestamp after year 9999",
      "'10000-01-01 00:00:00'::timestamp",
      Temporal.PlainDateTime.from("+010000-01-01T00:00:00"),
    ],
    [
      "timestamptz BC",
      "'0001-01-01 00:00:00+00 BC'::timestamptz",
      Temporal.Instant.from("0000-01-01T00:00:00Z"),
    ],
    ["time", "'23:59:59.999999'::time", Temporal.PlainTime.from("23:59:59.999999")],
    [
      "interval",
      "'1 year 2 mons -3 days 04:05:06.789'::interval",
      { months: 14, days: -3, microseconds: 14_706_789_000n },
    ],
    [
      "negative interval time",
      "'-00:00:01.5'::interval",
      { months: 0, days: 0, microseconds: -1_500_000n },
    ],
    ["jsonb", `'{"a": [1, "x", null]}'::jsonb`, { a: [1, "x", null] }],
    ["json string", `'"x"'::json`, "x"],
    ["bytea", String.raw`'\x00ff10'::bytea`, new Uint8Array([0, 255, 16])],
    ["int4 array with null", "array[1, null, 3]::int4[]", [1, null, 3]],
    ["text array with quotes", `array['a,b', 'c"d', '', null]::text[]`, ["a,b", 'c"d', "", null]],
    [
      "nested array",
      "array[[1, 2], [3, 4]]::int4[]",
      [
        [1, 2],
        [3, 4],
      ],
    ],
    [
      "int4range",
      "int4range(1, 5)",
      { lower: 1, upper: 5, lowerInclusive: true, upperInclusive: false },
    ],
    [
      "unbounded range",
      "'(,5]'::int8range",
      { lower: null, upper: "6", lowerInclusive: false, upperInclusive: false },
    ],
    ["empty range", "'empty'::int4range", "empty"],
    [
      "daterange",
      "daterange('2000-01-01', '2000-02-01')",
      {
        lower: Temporal.PlainDate.from("2000-01-01"),
        upper: Temporal.PlainDate.from("2000-02-01"),
        lowerInclusive: true,
        upperInclusive: false,
      },
    ],
    ["null", "null::int4", null],
  ])("%s", async ([, expression, expected], { drivers }) => {
    for (const connection of drivers) {
      await expect(selectOne(connection, expression)).resolves.toStrictEqual(expected);
    }
  });

  test.for<readonly [string, string, string]>([
    ["infinite date", "'infinity'::date", "infinity"],
    ["time 24:00", "'24:00:00'::time", "24:00:00"],
  ])(
    "rejects a value its type cannot hold exactly: %s",
    async ([, expression, value], { drivers }) => {
      for (const connection of drivers) {
        await expect(selectOne(connection, expression)).rejects.toThrow(`"${value}"`);
      }
    },
  );
});

describe("encoding parameters", () => {
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
