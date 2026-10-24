import type { PGlite } from "@electric-sql/pglite";

import { checksJson, parseCheck } from "./checks.ts";
import type { CheckRow } from "./checks.ts";
import { parseComment } from "./comments.ts";
import { constraintsJson, parseConstraints } from "./constraints.ts";
import type { ConstraintRows } from "./constraints.ts";
import { indexesJson, parseIndex } from "./indexes.ts";
import type { IndexRow } from "./indexes.ts";
import type { Column, ColumnValue, Table } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface TableRow extends ConstraintRows {
  readonly comment: string | null;
  readonly checks: readonly CheckRow[];
  readonly indexes: readonly IndexRow[];
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnRow[];
}

interface ColumnRow {
  readonly name: string;
  readonly type: TypeRow;
  readonly typeSql: string;
  readonly notNull: boolean;
  readonly identity: "" | "a" | "d";
  readonly generated: "" | "s" | "v";
  readonly expression: string | null;
  readonly comment: string | null;
}

export async function readTables(db: PGlite): Promise<Table[]> {
  const { rows } = await db.query<TableRow>(`
    select n.nspname as schema, c.relname as name, obj_description(c.oid, 'pg_class') as comment,
      coalesce((
        select json_agg(json_build_object(
          'name', a.attname,
          'type', ${typeRefJson("a.atttypid")},
          'typeSql', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull,
          'comment', col_description(a.attrelid, a.attnum),
          'identity', a.attidentity,
          'generated', a.attgenerated,
          'expression', pg_get_expr(d.adbin, d.adrelid)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]') as columns,
      ${constraintsJson("c")},
      ${checksJson("c")},
      ${indexesJson("c")}
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}
    order by n.nspname, c.relname
  `);
  return rows.map((row) => parseTable(row));
}

function parseTable(row: TableRow): Table {
  return {
    schema: row.schema,
    name: row.name,
    columns: row.columns.map((column) => parseColumn(column)),
    ...parseConstraints(row),
    checks: row.checks.map((check) => parseCheck(check)),
    indexes: row.indexes.map((index) => parseIndex(index)),
    comment: parseComment(row.comment),
  };
}

function parseColumn(row: ColumnRow): Column {
  return {
    name: row.name,
    type: parseTypeRef(row.type),
    typeSql: row.typeSql,
    notNull: row.notNull,
    value: parseColumnValue(row),
    comment: parseComment(row.comment),
  };
}

function parseColumnValue(row: ColumnRow): ColumnValue {
  if (row.identity !== "") {
    return { kind: "identity", generation: row.identity === "a" ? "always" : "by default" };
  }
  if (row.expression === null) {
    return { kind: "none" };
  }
  if (row.generated !== "") {
    const storage = row.generated === "s" ? "stored" : "virtual";
    return { kind: "generated", storage, expression: row.expression };
  }
  return { kind: "default", expression: row.expression };
}
