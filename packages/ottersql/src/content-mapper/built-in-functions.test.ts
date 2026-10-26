import { describe, expect, test } from "vitest";

import { openSchema } from "../catalog/index.ts";
import type { OpenSchema } from "../catalog/index.ts";
import { openQuerySession } from "./index.ts";

// Edge values per argument type: empty and blank text, zero, negatives, NaN, infinities, extremes.
const edgeValues: Readonly<Record<string, readonly string[]>> = {
  text: ["''", "' '", "'a'", String.raw`E'\n'`],
  int2: ["0", "-1", "32767"],
  int4: ["0", "-1", "2147483647"],
  int8: ["0", "-1", "9223372036854775807"],
  numeric: ["0", "-1.5", "'NaN'", "'Infinity'"],
  float8: ["0", "-1.5", "'NaN'", "'Infinity'", "'-Infinity'"],
  date: ["'2000-01-01'", "'infinity'", "'-infinity'"],
  timestamp: ["'2000-01-01'", "'infinity'", "'-infinity'"],
  timestamptz: ["'2000-01-01Z'", "'infinity'", "'-infinity'"],
  interval: ["'0'", "'-1 day'", "'1 mon -3 days'"],
  bytea: [String.raw`'\x'`, String.raw`'\x00ff'`],
};

interface Call {
  readonly sql: string;
}

/** Calls of every built-in function whose arguments all have edge values, varying one at a time. */
async function builtInCalls(schema: OpenSchema): Promise<Call[]> {
  const { rows } = await schema.database.query<{ name: string; types: readonly string[] }>(
    `select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) as t) as types
     from pg_proc p
     where p.pronamespace = 'pg_catalog'::regnamespace and p.prokind = 'f' and not p.proretset
       and p.pronargs between 0 and 3`,
  );
  const typeNames: Readonly<Record<string, string>> = {
    "character varying": "text",
    smallint: "int2",
    integer: "int4",
    bigint: "int8",
    "double precision": "float8",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz",
  };
  return rows.flatMap((row) => {
    const types = row.types.map((type) => typeNames[type] ?? type);
    const values = types.map((type) => edgeValues[type]);
    if (values.some((candidates) => candidates === undefined)) {
      return [];
    }
    const first = values.map(
      (candidates, index) => `${candidates?.[0] ?? ""}::${types[index] ?? ""}`,
    );
    const variations = values.flatMap((candidates, index) =>
      (candidates ?? [])
        .slice(1)
        .map((value) => first.with(index, `${value}::${types[index] ?? ""}`)),
    );
    return [first, ...variations].map((args) => ({
      sql: `select ${row.name}(${args.join(", ")}) as v`,
    }));
  });
}

/** The statements among `sql` that return a null `v`; statements that fail return nothing at all. */
async function callsReturningNull(schema: OpenSchema, sql: readonly string[]): Promise<string[]> {
  const nulls: string[] = [];
  for (const statement of sql) {
    const result = await schema.database.query<{ v: unknown }>(statement).catch(() => null);
    if (result !== null && result.rows[0]?.v === null) {
      nulls.push(statement);
    }
  }
  return nulls;
}

describe("built-in functions", () => {
  test("never return null at run time where ottersql types them non-null", async () => {
    const schema = await openSchema("");
    const session = await openQuerySession("");
    try {
      const calls = await builtInCalls(schema);
      const content = calls
        .map((call, index) => `-- @name q${String(index)}\n${call.sql};`)
        .join("\n\n");
      const described = await session.describeFile(content);
      const provenNonNull = described.queries.filter(
        (query) => query.columns[0]?.nullable === false,
      );
      const nullAtRunTime = await callsReturningNull(
        schema,
        provenNonNull.map((query) => query.query.sql),
      );
      expect({ checked: provenNonNull.length > 100, nullAtRunTime }).toStrictEqual({
        checked: true,
        nullAtRunTime: [],
      });
    } finally {
      await session.close();
      await schema.close();
    }
  }, 120_000);
});
