import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test as base } from "vitest";

import { DecodeError, defineQuery, json } from "./index.ts";
import type { Connection } from "./index.ts";
import { pgliteConnection } from "./pglite.ts";
import { openDrivers } from "./test-drivers.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

/** Every message in `error`'s chain of causes: where a value from a row or a parameter must not appear. */
function errorChainText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

/** `value` in hex when it holds bytes, for comparing large ones quickly. */
function hexOf(value: unknown): string | null {
  return value instanceof Uint8Array ? value.toHex() : null;
}

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
    ["int2vector, as its text", "'1 2'::int2vector", "1 2"],
    [
      "box[], whose elements Postgres separates with semicolons",
      "array['(1,1),(0,0)'::box, '(2,2),(1,1)'::box]",
      ["(1,1),(0,0)", "(2,2),(1,1)"],
    ],
    ["null", "null::int4", null],
  ])("%s", async ([, expression, expected], { drivers }) => {
    for (const connection of drivers) {
      await expect(selectOne(connection, expression)).resolves.toStrictEqual(expected);
    }
  });

  test.for<readonly [string, string, string, string]>([
    ["infinite date", "'infinity'::date", "infinity", "date"],
    ["time 24:00", "'24:00:00'::time", "24:00:00", "time"],
    ["infinite date in an array", "array['infinity']::date[]", "infinity", "date[]"],
  ])(
    "rejects a value its type cannot hold exactly, naming the column but not the value: %s",
    async ([, expression, value, type], { drivers }) => {
      for (const connection of drivers) {
        const rejected = selectOne(connection, expression);
        await expect(rejected).rejects.toThrow(
          new DecodeError(`Column "v" has a value that cannot be decoded as ${type}`),
        );
        await expect(rejected.catch(errorChainText)).resolves.not.toContain(value);
      }
    },
  );

  test("reads intervals in the iso_8601 style as in the postgres style, signs included", async () => {
    const db = await PGlite.create();
    try {
      const values = [
        "'-4 hours -5 minutes -6 seconds'::interval",
        "'-1 hour -0.5 second'::interval",
        "'1 year -2 mons 3 days -4 hours 5 minutes -6.25 seconds'::interval",
        "'0.000001 second'::interval",
      ];
      const inPostgresStyle = await Promise.all(
        values.map(async (value) => selectOne(pgliteConnection(db), value)),
      );
      await db.exec("set intervalstyle = iso_8601");
      for (const [index, value] of values.entries()) {
        await expect(selectOne(pgliteConnection(db), value)).resolves.toStrictEqual(
          inPostgresStyle[index],
        );
      }
    } finally {
      await db.close();
    }
  });

  test("rejects an interval in a style it does not read, saying which styles it reads", async () => {
    const db = await PGlite.create();
    try {
      await db.exec("set intervalstyle = sql_standard");
      await expect(
        selectOne(pgliteConnection(db), "'1 year 2 mons 3 days'::interval"),
      ).rejects.toThrow(
        new DecodeError(
          'Column "v" has a value that cannot be decoded as interval: unsupported interval format; set IntervalStyle to postgres or iso_8601',
        ),
      );
    } finally {
      await db.close();
    }
  });

  test("decodes and encodes bytea of several megabytes", async ({ drivers }) => {
    // Three megabytes: above the two where a regular expression over the text ran out of stack.
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_byte, index) => index % 251);
    const roundTrip = defineQuery("select $1::bytea as v", ["v"]);
    for (const connection of drivers) {
      const { v } = await roundTrip.one(connection, { v: bytes });
      // Compared as hex: a deep comparison of millions of elements takes seconds.
      expect(hexOf(v)).toBe(bytes.toHex());
    }
  });

  test("rejects bytea in the escape output format, which hex decoding would corrupt", async () => {
    const db = await PGlite.create();
    try {
      await db.exec("set bytea_output = escape");
      await expect(selectOne(pgliteConnection(db), "'abc'::bytea")).rejects.toThrow(
        new DecodeError(
          'Column "v" has a value that cannot be decoded as bytea: not bytea in the hex output format',
        ),
      );
    } finally {
      await db.close();
    }
  });
});

describe("encoding parameters", () => {
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
