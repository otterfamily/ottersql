import { array, nullable, string } from "./catalog-json.ts";
import type { Field } from "./catalog-json.ts";
import type { Table } from "./model.ts";
import { partitionedByJson, partitionOfJson, partitionRow } from "./partitions.ts";
import type { Partition } from "./partitions.ts";
import { parseRowSecurity, policiesJson, policyRow, rowSecurityJson } from "./policies.ts";
import type { Policy } from "./policies.ts";

/** How a table is partitioned and who may see its rows, as the table query selects them. */
export interface TableSettingsRow {
  readonly partitionedBy: string | null;
  readonly partitionOf: Partition | null;
  readonly rowSecurity: string;
  readonly policies: readonly Policy[];
}

export function tableSettingsRow(field: Field): TableSettingsRow {
  return {
    partitionedBy: field("partitionedBy", nullable(string)),
    partitionOf: field("partitionOf", nullable(partitionRow)),
    rowSecurity: field("rowSecurity", string),
    policies: field("policies", array(policyRow)),
  };
}

/** The columns that select a table's settings, for the pg_class row `c`. */
export function tableSettingsJson(): string {
  return `${partitionedByJson()} as "partitionedBy",
        ${partitionOfJson()} as "partitionOf",
        ${rowSecurityJson()} as "rowSecurity",
        ${policiesJson("c.oid")} as policies`;
}

export function parseTableSettings(
  row: TableSettingsRow,
): Pick<Table, "partitionedBy" | "partitionOf" | "rowSecurity" | "policies"> {
  return {
    partitionedBy: row.partitionedBy,
    partitionOf: row.partitionOf,
    rowSecurity: parseRowSecurity(row.rowSecurity),
    policies: row.policies,
  };
}
