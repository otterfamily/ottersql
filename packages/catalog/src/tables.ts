import type { PGlite } from "@electric-sql/pglite";

import { checksJson, parseTableCheck } from "./checks.ts";
import type { TableCheckRow } from "./checks.ts";
import { decode } from "./codes.ts";
import { columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import { parseComment } from "./comments.ts";
import { keysJson, parseKeys } from "./constraints.ts";
import type { KeyRows } from "./constraints.ts";
import { indexesJson, parseIndex } from "./indexes.ts";
import type { IndexRow } from "./indexes.ts";
import type { Column, ColumnValue, Table } from "./model.ts";
import { userObject } from "./scope.ts";

interface TableRow extends KeyRows {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnRow[];
  readonly checks: readonly TableCheckRow[];
  readonly indexes: readonly IndexRow[];
  readonly comment: string | null;
}

interface ColumnRow extends ColumnBaseRow {
  readonly notNull: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly volatile: boolean;
}

// A NOT VALID not-null constraint still sets attnotnull, but existing rows may hold NULL. A default
// is volatile when its stored expression tree calls a volatile function, directly or through an
// operator: dependencies on built-in functions are not recorded in pg_depend, so the tree is read.
const columnFields = `
  'notNull', col_attr.attnotnull and not exists (
    select from pg_constraint col_not_null
    where col_not_null.conrelid = col_attr.attrelid and col_not_null.contype = 'n'
      and col_not_null.conkey[1] = col_attr.attnum and not col_not_null.convalidated
  ),
  'identity', col_attr.attidentity,
  'generated', col_attr.attgenerated,
  'expression', pg_get_expr(col_default.adbin, col_default.adrelid),
  'volatile', coalesce((
    select bool_or(col_func.provolatile = 'v')
    from regexp_matches(col_default.adbin::text, ':(funcid|opno) (\\d+)', 'g') as col_node(found)
      join pg_proc col_func on col_func.oid = case col_node.found[1]
        when 'funcid' then col_node.found[2]::oid
        else (select oprcode from pg_operator where oid = col_node.found[2]::oid)::oid
      end
  ), false)`;

export async function readTables(db: PGlite): Promise<Table[]> {
  const { rows } = await db.query<TableRow>(`
    select n.nspname as schema, c.relname as name,
      ${columnsJson("c.oid", columnFields)} as columns,
      ${keysJson("c.oid")},
      ${checksJson("c.oid")} as checks,
      ${indexesJson("c.oid")} as indexes,
      obj_description(c.oid, 'pg_class') as comment
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}
    order by n.nspname, c.relname
  `);
  return rows.map((row) => parseTable(row));
}

function parseTable(row: TableRow): Table {
  const { primaryKey, uniqueConstraints, foreignKeys } = parseKeys(row);
  return {
    schema: row.schema,
    name: row.name,
    columns: row.columns.map((column) => parseColumn(column)),
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    checks: row.checks.map((check) => parseTableCheck(check)),
    indexes: row.indexes.map((index) => parseIndex(index)),
    comment: parseComment(row.comment),
  };
}

function parseColumn(row: ColumnRow): Column {
  return { ...parseColumnBase(row), notNull: row.notNull, value: parseColumnValue(row) };
}

const identityGenerations = { a: "always", d: "by default" } as const;
const generatedStorages = { s: "stored", v: "virtual" } as const;

function parseColumnValue(row: ColumnRow): ColumnValue {
  if (row.identity !== "") {
    const generation = decode(identityGenerations, row.identity, "pg_attribute.attidentity");
    return { kind: "identity", generation };
  }
  if (row.expression === null) {
    return { kind: "none" };
  }
  if (row.generated !== "") {
    const storage = decode(generatedStorages, row.generated, "pg_attribute.attgenerated");
    return { kind: "generated", storage, expression: row.expression };
  }
  return { kind: "default", expression: row.expression, volatile: row.volatile };
}
