import type { Transaction } from "../sql/index.ts";
import { array, boolean, fields, nullable, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import { parseComment } from "./comments.ts";
import type { View } from "./model.ts";
import { scopeParameters, userObject } from "./scope.ts";

interface ViewRow {
  readonly schema: string;
  readonly name: string;
  readonly materialized: boolean;
  readonly columns: readonly ColumnBaseRow[];
  readonly comment: string | null;
}

const viewRow: Shape<ViewRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    materialized: field("materialized", boolean),
    columns: field("columns", array(columnBaseRow)),
    comment: field("comment", nullable(string)),
  };
};

export async function readViews(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<View[]> {
  const rows = await queryRows(transaction, {
    select: `select n.nspname as schema, c.relname as name, c.relkind = 'm' as materialized,
        ${columnsJson("c.oid")} as columns,
        obj_description(c.oid, 'pg_class') as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm') and ${userObject("pg_class", "c.oid", "c.relnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: viewRow,
    label: "views",
    parameters: scopeParameters(omitSchemas),
  });
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    materialized: row.materialized,
    columns: row.columns.map((column) => parseColumnBase(column)),
    comment: parseComment(row.comment),
  }));
}
