import type { Connection } from "../sql/index.ts";
import { queryRows } from "./catalog-json.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Table } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTable, tableRow, tablePartsJson } from "./table-parts.ts";

export async function readTables(
  connection: Connection,
  features: CatalogFeatures,
): Promise<Table[]> {
  const rows = await queryRows(connection, {
    select: `select n.nspname as schema, c.relname as name,
        ${tablePartsJson(features)}
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: tableRow,
    label: "tables",
  });
  return rows.map((row) => parseTable(row));
}
