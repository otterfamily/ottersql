import type { Transaction } from "../sql/index.ts";
import { queryRows } from "./catalog-json.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Table } from "./model.ts";
import { scopeParameters, userObject } from "./scope.ts";
import { parseTable, tableRow, tablePartsJson } from "./table-parts.ts";

export async function readTables(
  transaction: Transaction,
  features: CatalogFeatures,
  omitSchemas: readonly string[],
): Promise<Table[]> {
  const rows = await queryRows(transaction, {
    select: `select n.nspname as schema, c.relname as name,
        ${tablePartsJson(features)}
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${userObject("pg_class", "c.oid", "c.relnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: tableRow,
    label: "tables",
    parameters: scopeParameters(omitSchemas),
  });
  return rows.map((row) => parseTable(row));
}
