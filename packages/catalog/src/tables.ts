import type { Connection } from "@ottersql/sql";

import { array, fields, nullable, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { checksJson, parseTableCheck, tableCheckRow } from "./checks.ts";
import type { TableCheckRow } from "./checks.ts";
import { parseComment } from "./comments.ts";
import { keyRows, keysJson, parseKeys } from "./constraints.ts";
import type { KeyRows } from "./constraints.ts";
import type { CatalogFeatures } from "./features.ts";
import { indexesJson, indexRow, parseIndex } from "./indexes.ts";
import type { IndexRow } from "./indexes.ts";
import type { Table } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTableColumn, tableColumnRow, tableColumnsJson } from "./table-columns.ts";
import type { TableColumnRow } from "./table-columns.ts";

interface TableRow extends KeyRows {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly TableColumnRow[];
  readonly checks: readonly TableCheckRow[];
  readonly indexes: readonly IndexRow[];
  readonly comment: string | null;
}

const tableRow: Shape<TableRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...keyRows(field),
    schema: field("schema", string),
    name: field("name", string),
    columns: field("columns", array(tableColumnRow)),
    checks: field("checks", array(tableCheckRow)),
    indexes: field("indexes", array(indexRow)),
    comment: field("comment", nullable(string)),
  };
};

export async function readTables(
  connection: Connection,
  features: CatalogFeatures,
): Promise<Table[]> {
  const rows = await queryRows(connection, {
    select: `select n.nspname as schema, c.relname as name,
        ${tableColumnsJson("c.oid")} as columns,
        ${keysJson("c.oid", features)},
        ${checksJson("c.oid", features)} as checks,
        ${indexesJson("c.oid")} as indexes,
        obj_description(c.oid, 'pg_class') as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: tableRow,
    label: "tables",
  });
  return rows.map((row) => parseTable(row));
}

function parseTable(row: TableRow): Table {
  const { primaryKey, uniqueConstraints, foreignKeys } = parseKeys(row);
  return {
    schema: row.schema,
    name: row.name,
    columns: row.columns.map((column) => parseTableColumn(column)),
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    checks: row.checks.map((check) => parseTableCheck(check)),
    indexes: row.indexes.map((index) => parseIndex(index)),
    comment: parseComment(row.comment),
  };
}
