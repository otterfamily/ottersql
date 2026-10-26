import { boolean, fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import type { Column, ColumnValue } from "./model.ts";
import { callsVolatile } from "./volatility.ts";

export interface TableColumnRow extends ColumnBaseRow {
  readonly notNull: boolean;
  readonly notNullNoInherit: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly volatile: boolean;
}

// A NOT VALID not-null constraint still sets attnotnull, but existing rows may hold NULL.
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
  'volatile', ${callsVolatile("col_default.adbin", "col")}`;

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
    identity: field("identity", string),
    generated: field("generated", string),
    expression: field("expression", nullable(string)),
    volatile: field("volatile", boolean),
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
  return { kind: "default", expression: row.expression, volatile: row.volatile };
}
