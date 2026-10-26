import { describe, expect, test } from "vitest";

import { openSchema } from "../catalog/index.ts";
import type { OpenSchema } from "../catalog/index.ts";
import { openQuerySession } from "./session.ts";
import type { DescribedFile } from "./session.ts";

// Edge values per argument type: empty and blank text, zero, negatives, NaN, infinities, extremes,
// and JSON's own null. int4's extreme is its smallest: with its largest, repeat('', n) loops for
// tens of seconds, and PGlite ignores statement_timeout.
const edgeValues: Readonly<Record<string, readonly string[]>> = {
  text: ["''", "' '", "'a'", String.raw`E'\n'`],
  bool: ["true", "false"],
  int2: ["0", "-1", "32767"],
  int4: ["0", "-1", "-2147483648"],
  int8: ["0", "-1", "9223372036854775807"],
  numeric: ["0", "-1.5", "'NaN'", "'Infinity'"],
  float4: ["0", "-1.5", "'NaN'", "'Infinity'", "'-Infinity'"],
  float8: ["0", "-1.5", "'NaN'", "'Infinity'", "'-Infinity'"],
  date: ["'2000-01-01'", "'infinity'", "'-infinity'"],
  timestamp: ["'2000-01-01'", "'infinity'", "'-infinity'"],
  timestamptz: ["'2000-01-01Z'", "'infinity'", "'-infinity'"],
  interval: ["'0'", "'-1 day'", "'1 mon -3 days'"],
  bytea: [String.raw`'\x'`, String.raw`'\x00ff'`],
  uuid: ["'00000000-0000-0000-0000-000000000000'"],
  jsonb: ["'{}'", "'null'", "'[1]'", `'{"a": null}'`],
};

const typeNames: Readonly<Record<string, string>> = {
  boolean: "bool",
  "character varying": "text",
  smallint: "int2",
  integer: "int4",
  bigint: "int8",
  real: "float4",
  "double precision": "float8",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
};

/**
 * One function or operator applied to arguments of fixed types, as calls with every variation of
 * edge values. The nullability ottersql proves depends on the types alone, so only the first call
 * is described, and every call runs.
 */
type Signature = readonly [string, ...string[]];

/** The argument lists of edge values for `types`, varying one argument at a time, or none. */
function variationsOf(rawTypes: readonly string[]): (readonly string[])[] {
  const types = rawTypes.map((type) => typeNames[type] ?? type);
  const values = types.map((type) => edgeValues[type]);
  if (values.some((candidates) => candidates === undefined)) {
    return [];
  }
  const typed = (value: string, index: number): string => `(${value})::${types[index] ?? ""}`;
  const first = values.map((candidates, index) => typed(candidates?.[0] ?? "", index));
  return [
    first,
    ...values.flatMap((candidates, index) =>
      (candidates ?? []).slice(1).map((value) => first.with(index, typed(value, index))),
    ),
  ];
}

/** Every built-in function of up to three arguments and every binary operator with edge values. */
async function builtInSignatures(schema: OpenSchema): Promise<Signature[]> {
  const { rows: functions } = await schema.database.query<{ name: string; types: string[] }>(
    `select p.proname as name, array(select format_type(t, null) from unnest(p.proargtypes) as t) as types
     from pg_proc p
     where p.pronamespace = 'pg_catalog'::regnamespace and p.prokind = 'f' and not p.proretset
       and p.pronargs between 0 and 3`,
  );
  const { rows: operators } = await schema.database.query<{ name: string; types: string[] }>(
    `select o.oprname as name, array[format_type(o.oprleft, null), format_type(o.oprright, null)] as types
     from pg_operator o
     where o.oprnamespace = 'pg_catalog'::regnamespace and o.oprkind = 'b'`,
  );
  const calls = [
    ...functions.map(({ name, types }) =>
      variationsOf(types).map((args) => `select ${name}(${args.join(", ")}) as v`),
    ),
    ...operators.map(({ name, types }) =>
      variationsOf(types).map(
        ([left, right]) => `select ${left ?? ""} ${name} ${right ?? ""} as v`,
      ),
    ),
  ];
  return calls.filter((signature): signature is [string, ...string[]] => signature.length > 0);
}

/** A query file of each signature's first call, its query named by the signature's index. */
function firstCalls(signatures: readonly Signature[]): string {
  return signatures.map(([first], index) => `-- @name q${String(index)}\n${first};`).join("\n\n");
}

/** Every call of the signatures whose first call `file` proves non-null. */
function callsProvenNonNull(signatures: readonly Signature[], file: DescribedFile): string[] {
  return file.queries
    .filter((query) => query.columns[0]?.nullable === false)
    .flatMap((query) => signatures[Number(query.name.slice(1))] ?? []);
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

describe("built-in functions and operators", () => {
  test("never return null at run time where ottersql types them non-null", async () => {
    const schema = await openSchema("");
    const session = await openQuerySession("");
    try {
      const signatures = await builtInSignatures(schema);
      const described = await session.describeFile(firstCalls(signatures));
      const provenNonNull = callsProvenNonNull(signatures, described);
      const nullAtRunTime = await callsReturningNull(schema, provenNonNull);
      expect({ checked: provenNonNull.length > 1000, nullAtRunTime }).toStrictEqual({
        checked: true,
        nullAtRunTime: [],
      });
    } finally {
      await session.close();
      await schema.close();
    }
  }, 120_000);
});
