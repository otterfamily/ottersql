import { boolean, fields, nullable, qualifiedName, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import type { Column, ColumnValue, QualifiedName } from "./model.ts";
import { sequenceFields, sequenceRow } from "./sequences.ts";
import type { Sequence } from "./sequences.ts";
import { callsVolatile } from "./volatility.ts";

export interface TableColumnRow extends ColumnBaseRow {
  readonly notNull: boolean;
  readonly notNullNoInherit: boolean;
  readonly collation: QualifiedName | null;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly volatile: boolean;
  readonly sequence: Sequence | null;
}

// A NOT VALID not-null constraint still sets attnotnull, but existing rows may hold NULL.
// A sequence counts as the column's only when the column owns it (an 'a' dependency, as serial
// makes; identity's are 'i') and the default is nothing but its nextval. A collation counts only
// when it is not the one the column's type has anyway.
const columnFields = `
  'collation', case when col_attr.attcollation <> 0 then (
    select json_build_object('schema', col_coll_ns.nspname, 'name', col_coll.collname)
    from pg_collation col_coll
    join pg_namespace col_coll_ns on col_coll_ns.oid = col_coll.collnamespace
    join pg_type col_coll_type on col_coll_type.oid = col_attr.atttypid
    where col_coll.oid = col_attr.attcollation and col_attr.attcollation <> col_coll_type.typcollation
  ) end,
  'notNull', col_attr.attnotnull and not exists (
    select from pg_constraint col_not_null
    where col_not_null.conrelid = col_attr.attrelid and col_not_null.contype = 'n'
      and col_not_null.conkey[1] = col_attr.attnum and not col_not_null.convalidated
  ),
  'notNullNoInherit', exists (
    select from pg_constraint col_no_inherit
    where col_no_inherit.conrelid = col_attr.attrelid and col_no_inherit.contype = 'n'
      and col_no_inherit.conkey[1] = col_attr.attnum and col_no_inherit.connoinherit
  ),
  'identity', col_attr.attidentity,
  'generated', col_attr.attgenerated,
  'expression', pg_get_expr(col_default.adbin, col_default.adrelid),
  'volatile', ${callsVolatile("col_default.adbin", "col")},
  'sequence', (
    select json_build_object(${sequenceFields("col_seq_class", "col_seq_ns")})
    from pg_depend col_seq_dep
    join pg_class col_seq_class on col_seq_class.oid = col_seq_dep.objid
    join pg_namespace col_seq_ns on col_seq_ns.oid = col_seq_class.relnamespace
    join pg_sequence seq on seq.seqrelid = col_seq_class.oid
    where col_seq_dep.classid = 'pg_class'::regclass
      and col_seq_dep.refclassid = 'pg_class'::regclass
      and col_seq_dep.refobjid = col_attr.attrelid and col_seq_dep.refobjsubid = col_attr.attnum
      and col_seq_dep.deptype = 'a' and col_seq_class.relkind = 'S'
      and pg_get_expr(col_default.adbin, col_default.adrelid)
        = format('nextval(%L::regclass)', col_seq_class.oid::regclass::text)
  )`;

/** Selects the columns of the table `relationOid` as `parseTableColumn` reads them. */
export function tableColumnsJson(relationOid: string): string {
  return columnsJson(relationOid, columnFields);
}

export const tableColumnRow: Shape<TableColumnRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...columnBaseRow(value, path),
    notNull: field("notNull", boolean),
    notNullNoInherit: field("notNullNoInherit", boolean),
    collation: field("collation", nullable(qualifiedName)),
    identity: field("identity", string),
    generated: field("generated", string),
    expression: field("expression", nullable(string)),
    volatile: field("volatile", boolean),
    sequence: field("sequence", nullable(sequenceRow)),
  };
};

export function parseTableColumn(row: TableColumnRow): Column {
  return {
    ...parseColumnBase(row),
    notNull: row.notNull,
    notNullNoInherit: row.notNullNoInherit,
    collation: row.collation,
    value: parseColumnValue(row),
  };
}

const identityGenerations = { a: "always", d: "by default" } as const;
const generatedStorages = { s: "stored", v: "virtual" } as const;

function parseColumnValue(row: TableColumnRow): ColumnValue {
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
  return row.sequence === null
    ? { kind: "default", expression: row.expression, volatile: row.volatile }
    : { kind: "sequence", sequence: row.sequence };
}
