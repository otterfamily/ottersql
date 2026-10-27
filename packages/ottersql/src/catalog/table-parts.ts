import { array, fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { checksJson, parseTableCheck, tableCheckRow } from "./checks.ts";
import type { TableCheckRow } from "./checks.ts";
import { parseComment } from "./comments.ts";
import { keyRows, keysJson, parseKeys } from "./constraints.ts";
import type { KeyRows } from "./constraints.ts";
import type { CatalogFeatures } from "./features.ts";
import { indexesJson, indexRow, parseIndex } from "./indexes.ts";
import type { IndexRow } from "./indexes.ts";
import type { Table } from "./model/table.ts";
import { parseTableColumn, tableColumnRow, tableColumnsJson } from "./table-columns.ts";
import type { TableColumnRow } from "./table-columns.ts";
import { parseTableSettings, tableSettingsJson, tableSettingsRow } from "./table-settings.ts";
import type { TableSettingsRow } from "./table-settings.ts";
import { parseTrigger, triggerRow, triggersJson } from "./triggers.ts";
import type { TriggerRow } from "./triggers.ts";

export interface TableRow extends KeyRows, TableSettingsRow {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly TableColumnRow[];
  readonly checks: readonly TableCheckRow[];
  readonly indexes: readonly IndexRow[];
  readonly triggers: readonly TriggerRow[];
  readonly comment: string | null;
}

export const tableRow: Shape<TableRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...keyRows(field),
    ...tableSettingsRow(field),
    schema: field("schema", string),
    name: field("name", string),
    columns: field("columns", array(tableColumnRow)),
    checks: field("checks", array(tableCheckRow)),
    indexes: field("indexes", array(indexRow)),
    triggers: field("triggers", array(triggerRow)),
    comment: field("comment", nullable(string)),
  };
};

/** The columns that select what a table holds, for the pg_class row `c`. */
export function tablePartsJson(features: CatalogFeatures): string {
  return `
        ${tableColumnsJson("c.oid")} as columns,
        ${keysJson("c.oid", features)},
        ${checksJson("c.oid", features)} as checks,
        ${indexesJson("c.oid")} as indexes,
        ${triggersJson("c.oid")} as triggers,
        ${tableSettingsJson()},
        obj_description(c.oid, 'pg_class') as comment`;
}

export function parseTable(row: TableRow): Table {
  const { primaryKey, uniqueConstraints, foreignKeys, exclusionConstraints } = parseKeys(row);
  return {
    schema: row.schema,
    name: row.name,
    columns: row.columns.map((column) => parseTableColumn(column)),
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    checks: row.checks.map((check) => parseTableCheck(check)),
    exclusionConstraints,
    indexes: row.indexes.map((index) => parseIndex(index)),
    triggers: row.triggers.map((trigger) => parseTrigger(trigger)),
    ...parseTableSettings(row),
    comment: parseComment(row.comment),
  };
}
