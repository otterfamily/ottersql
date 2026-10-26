import { boolean, fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import type { Column, ColumnValue, Sequence } from "./model.ts";
import { callsVolatile } from "./volatility.ts";

export interface TableColumnRow extends ColumnBaseRow {
  readonly notNull: boolean;
  readonly notNullNoInherit: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly volatile: boolean;
  readonly sequence: Sequence | null;
}

// A NOT VALID not-null constraint still sets attnotnull, but existing rows may hold NULL.
// A sequence counts as the column's only when the column owns it (an 'a' dependency, as serial
// makes; identity's are 'i') and the default is nothing but its nextval.
const columnFields = `
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
    select json_build_object(
      'schema', col_seq_ns.nspname, 'name', col_seq_class.relname,
      'dataType', format_type(col_seq.seqtypid, null),
      'start', col_seq.seqstart::text, 'increment', col_seq.seqincrement::text,
      'minimum', col_seq.seqmin::text, 'maximum', col_seq.seqmax::text,
      'cache', col_seq.seqcache::text, 'cycle', col_seq.seqcycle
    )
    from pg_depend col_seq_dep
    join pg_class col_seq_class on col_seq_class.oid = col_seq_dep.objid
    join pg_namespace col_seq_ns on col_seq_ns.oid = col_seq_class.relnamespace
    join pg_sequence col_seq on col_seq.seqrelid = col_seq_class.oid
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

const sequenceRow: Shape<Sequence> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    dataType: field("dataType", string),
    start: field("start", string),
    increment: field("increment", string),
    minimum: field("minimum", string),
    maximum: field("maximum", string),
    cache: field("cache", string),
    cycle: field("cycle", boolean),
  };
};

export const tableColumnRow: Shape<TableColumnRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...columnBaseRow(value, path),
    notNull: field("notNull", boolean),
    notNullNoInherit: field("notNullNoInherit", boolean),
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
