import { catalogRead } from "./catalog-json.ts";
import type { CatalogRead } from "./catalog-json.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Table } from "./model/table.ts";
import { userObject } from "./scope.ts";
import { parseTable, tableRow, tableRowJson } from "./table-row.ts";

export function tablesRead(features: CatalogFeatures): CatalogRead<readonly Table[]> {
  return catalogRead(
    {
      select: `select n.nspname as schema, c.relname as name,
          ${tableRowJson(features)}
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}`,
      orderBy: "rows.schema, rows.name",
      row: tableRow,
      label: "tables",
    },
    (rows) => rows.map((row) => parseTable(row)),
  );
}
