import type { PGlite } from "@electric-sql/pglite";

import type { NullabilityFacts } from "./nullability.ts";

export type BuiltInFacts = Omit<NullabilityFacts, "isNotNullColumn">;

// Built-ins that return non-null for non-null arguments. Overloads taking ranges or multiranges,
// including the polymorphic anyrange family, are left out because `lower` and `upper` of an
// unbounded range are null; `to_char` is left out because some formats yield null.
const nonNullWhenArgumentsAre = [
  "abs",
  "bit_length",
  "btrim",
  "ceil",
  "ceiling",
  "char_length",
  "character_length",
  "clock_timestamp",
  "date_trunc",
  "floor",
  "gen_random_uuid",
  "initcap",
  "left",
  "length",
  "lower",
  "lpad",
  "ltrim",
  "md5",
  "mod",
  "now",
  "octet_length",
  "random",
  "repeat",
  "replace",
  "reverse",
  "right",
  "round",
  "rpad",
  "rtrim",
  "sign",
  "statement_timestamp",
  "transaction_timestamp",
  "trunc",
  "upper",
];

// Comparison, arithmetic and concatenation. Record operators are left out: their handling of null
// fields has not been checked.
const operators = ["+", "-", "*", "/", "%", "=", "<>", "<", "<=", ">", ">=", "||"];

const nonNullAggregates = [
  "count",
  "row_number",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
];

/** Reads the oids of the built-in functions and operators ADR 0009's allow-lists name. */
export async function readBuiltInFacts(db: PGlite): Promise<BuiltInFacts> {
  const { rows } = await db.query<{
    readonly aggregates: readonly string[];
    readonly functions: readonly string[];
    readonly operators: readonly string[];
    readonly concat: readonly string[];
    readonly casts: readonly string[];
  }>(
    `select
       array(select oid::text from pg_proc
             where pronamespace = 'pg_catalog'::regnamespace and prokind in ('a', 'w')
               and proname = any($1::text[])) as aggregates,
       array(select p.oid::text from pg_proc p
             where p.pronamespace = 'pg_catalog'::regnamespace and p.prokind = 'f'
               and p.proname = any($2::text[])
               and not exists (select from unnest(p.proargtypes) as arg(type)
                               join pg_type t on t.oid = arg.type
                               where t.typtype in ('r', 'm')
                                 or t.typname in ('anyrange', 'anymultirange', 'anycompatiblerange',
                                                  'anycompatiblemultirange'))) as functions,
       array(select o.oid::text from pg_operator o
             where o.oprnamespace = 'pg_catalog'::regnamespace and o.oprname = any($3::text[])
               and o.oprleft <> 'record'::regtype and o.oprright <> 'record'::regtype) as operators,
       array(select oid::text from pg_proc
             where pronamespace = 'pg_catalog'::regnamespace and proname = 'concat') as concat,
       array(select c.castfunc::text from pg_cast c join pg_proc p on p.oid = c.castfunc
             where p.pronamespace = 'pg_catalog'::regnamespace) as casts`,
    [nonNullAggregates, nonNullWhenArgumentsAre, operators],
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("reading built-in functions returned no row");
  }
  return {
    nonNullAggregates: new Set(row.aggregates),
    nonNullWhenArgumentsAre: new Set([...row.functions, ...row.operators]),
    neverNull: new Set(row.concat),
    nonNullCasts: new Set(row.casts),
  };
}
