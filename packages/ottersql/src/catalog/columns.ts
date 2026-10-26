import { fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { parseComment } from "./comments.ts";
import type { ViewColumn } from "./model.ts";
import { parseTypeRef, typeRefJson, typeRow } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

/**
 * Selects the names of the columns `attnums` of the relation `relationOid`, in the order given.
 * Its aliases start with `names_` so they cannot shadow the caller's.
 */
export function columnNames(relationOid: string, attnums: string): string {
  return `array(
    select names_attr.attname from unnest(${attnums}) with ordinality as names_key(attnum, ord)
    join pg_attribute names_attr
      on names_attr.attrelid = ${relationOid} and names_attr.attnum = names_key.attnum
    order by names_key.ord
  )`;
}

/**
 * Selects the columns of the relation `relationOid` in definition order, each with the fields
 * `parseColumnBase` reads plus `extraFields`, which may refer to the column as `col_attr` and its
 * default as `col_default`. Its aliases start with `col_` so they cannot shadow the caller's.
 */
export function columnsJson(relationOid: string, extraFields = ""): string {
  const extra = extraFields === "" ? "" : `, ${extraFields}`;
  return `coalesce((
    select json_agg(json_build_object(
      'name', col_attr.attname,
      'type', ${typeRefJson("col_attr.atttypid")},
      'typeSql', format_type(col_attr.atttypid, col_attr.atttypmod),
      'comment', col_description(col_attr.attrelid, col_attr.attnum)${extra}
    ) order by col_attr.attnum)
    from pg_attribute col_attr
    left join pg_attrdef col_default
      on col_default.adrelid = col_attr.attrelid and col_default.adnum = col_attr.attnum
    where col_attr.attrelid = ${relationOid} and col_attr.attnum > 0 and not col_attr.attisdropped
  ), '[]')`;
}

export interface ColumnBaseRow {
  readonly name: string;
  readonly type: TypeRow;
  readonly typeSql: string;
  readonly comment: string | null;
}

export const columnBaseRow: Shape<ColumnBaseRow> = (value, path) => {
  const field = fields(value, path);
  return {
    name: field("name", string),
    type: field("type", typeRow),
    typeSql: field("typeSql", string),
    comment: field("comment", nullable(string)),
  };
};

export function parseColumnBase(row: ColumnBaseRow): ViewColumn {
  return {
    name: row.name,
    type: parseTypeRef(row.type),
    typeSql: row.typeSql,
    comment: parseComment(row.comment),
  };
}
