import { array, nullable, qualifiedName, string } from "./catalog-json.ts";
import type { Field } from "./catalog-json.ts";
import type { QualifiedName, Table } from "./model.ts";
import { inheritsJson, partitionedByJson, partitionOfJson, partitionRow } from "./partitions.ts";
import type { Partition } from "./partitions.ts";
import { parseRowSecurity, policiesJson, policyRow, rowSecurityJson } from "./policies.ts";
import type { Policy } from "./policies.ts";

/** How a table is partitioned or inherits, and who may see its rows, as the table query selects them. */
export interface TableSettingsRow {
  readonly partitionedBy: string | null;
  readonly partitionOf: Partition | null;
  readonly inherits: readonly QualifiedName[];
  readonly rowSecurity: string;
  readonly policies: readonly Policy[];
}

export function tableSettingsRow(field: Field): TableSettingsRow {
  return {
    partitionedBy: field("partitionedBy", nullable(string)),
    partitionOf: field("partitionOf", nullable(partitionRow)),
    inherits: field("inherits", array(qualifiedName)),
    rowSecurity: field("rowSecurity", string),
    policies: field("policies", array(policyRow)),
  };
}

/** The columns that select a table's settings, for the pg_class row `c`. */
export function tableSettingsJson(): string {
  return `${partitionedByJson()} as "partitionedBy",
        ${partitionOfJson()} as "partitionOf",
        ${inheritsJson()} as inherits,
        ${rowSecurityJson()} as "rowSecurity",
        ${policiesJson("c.oid")} as policies`;
}

export function parseTableSettings(
  row: TableSettingsRow,
): Pick<Table, "partitionedBy" | "partitionOf" | "inherits" | "rowSecurity" | "policies"> {
  return {
    partitionedBy: row.partitionedBy,
    partitionOf: row.partitionOf,
    inherits: row.inherits,
    rowSecurity: parseRowSecurity(row.rowSecurity),
    policies: row.policies,
  };
}
