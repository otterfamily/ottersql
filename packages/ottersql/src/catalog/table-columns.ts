import {
  boolean,
  CatalogShapeError,
  fields,
  nullable,
  qualifiedName,
  string,
} from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { collationJson, columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import type { QualifiedName } from "./model/shared.ts";
import type { Column, ColumnValue, Sequence } from "./model/table.ts";
import { sequenceFields, sequenceRow } from "./sequences.ts";
import { callsVolatile } from "./volatility.ts";

export interface TableColumnRow extends ColumnBaseRow {
  readonly notNull: boolean;
  readonly notNullNoInherit: boolean;
  readonly collation: QualifiedName | null;
  readonly storage: string | null;
  readonly compression: string | null;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly volatile: boolean;
  readonly sequence: Sequence | null;
}

// A NOT VALID not-null constraint still sets attnotnull, but existing rows may hold NULL.
// A sequence counts as the column's when an identity column owns it (an 'i' dependency), or when
// a column owns it as serial makes it (an 'a' one) and the default is nothing but its nextval.
const columnFields = `
  ${collationJson},
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
  'storage', (
    select nullif(col_attr.attstorage, col_storage_type.typstorage)
    from pg_type col_storage_type where col_storage_type.oid = col_attr.atttypid
  ),
  'compression', nullif(col_attr.attcompression, ''),
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
      and col_seq_class.relkind = 'S'
      and (col_seq_dep.deptype = 'i' or (
        col_seq_dep.deptype = 'a' and pg_get_expr(col_default.adbin, col_default.adrelid)
          = format('nextval(%L::regclass)', col_seq_class.oid::regclass::text)
      ))
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
    storage: field("storage", nullable(string)),
    compression: field("compression", nullable(string)),
    identity: field("identity", string),
    generated: field("generated", string),
    expression: field("expression", nullable(string)),
    volatile: field("volatile", boolean),
    sequence: field("sequence", nullable(sequenceRow)),
  };
};

const storages = { e: "external", m: "main", p: "plain", x: "extended" } as const;
const compressions = { l: "lz4", p: "pglz" } as const;

export function parseTableColumn(row: TableColumnRow): Column {
  return {
    ...parseColumnBase(row),
    notNull: row.notNull,
    notNullNoInherit: row.notNullNoInherit,
    collation: row.collation,
    storage: row.storage === null ? null : decode(storages, row.storage, "pg_attribute.attstorage"),
    compression:
      row.compression === null
        ? null
        : decode(compressions, row.compression, "pg_attribute.attcompression"),
    value: parseColumnValue(row),
  };
}

const identityGenerations = { a: "always", d: "by default" } as const;
const generatedStorages = { s: "stored", v: "virtual" } as const;

function identityValue(row: TableColumnRow): ColumnValue {
  const generation = decode(identityGenerations, row.identity, "pg_attribute.attidentity");
  if (row.sequence === null) {
    throw new CatalogShapeError(`identity column ${row.name} has no sequence`);
  }
  return { kind: "identity", generation, sequence: row.sequence };
}

function parseColumnValue(row: TableColumnRow): ColumnValue {
  if (row.identity !== "") {
    return identityValue(row);
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
