import { array, boolean, nullable, qualifiedName, string } from "./catalog-json.ts";
import type { Field } from "./catalog-json.ts";
import type { QualifiedName } from "./model/shared.ts";
import type { Partition, Policy, Table } from "./model/table.ts";
import { inheritsJson, partitionedByJson, partitionOfJson, partitionRow } from "./partitions.ts";
import { parseRowSecurity, policiesJson, policyRow, rowSecurityJson } from "./policies.ts";

/** How a table is partitioned or inherits, and who may see its rows, as the table query selects them. */
export interface TableSettingsRow {
  readonly partitionedBy: string | null;
  readonly partitionOf: Partition | null;
  readonly inherits: readonly QualifiedName[];
  readonly unlogged: boolean;
  readonly options: readonly string[];
  readonly rowSecurity: string;
  readonly policies: readonly Policy[];
}

export function tableSettingsRow(field: Field): TableSettingsRow {
  return {
    partitionedBy: field("partitionedBy", nullable(string)),
    partitionOf: field("partitionOf", nullable(partitionRow)),
    inherits: field("inherits", array(qualifiedName)),
    unlogged: field("unlogged", boolean),
    options: field("options", array(string)),
    rowSecurity: field("rowSecurity", string),
    policies: field("policies", array(policyRow)),
  };
}

/** The columns that select a table's settings, for the pg_class row `c`. */
export function tableSettingsJson(): string {
  return `${partitionedByJson()} as "partitionedBy",
        ${partitionOfJson()} as "partitionOf",
        ${inheritsJson()} as inherits,
        c.relpersistence = 'u' as unlogged,
        coalesce(c.reloptions, '{}') as options,
        ${rowSecurityJson()} as "rowSecurity",
        ${policiesJson("c.oid")} as policies`;
}

export function parseTableSettings(
  row: TableSettingsRow,
): Pick<
  Table,
  "partitionedBy" | "partitionOf" | "inherits" | "unlogged" | "options" | "rowSecurity" | "policies"
> {
  return {
    partitionedBy: row.partitionedBy,
    partitionOf: row.partitionOf,
    inherits: row.inherits,
    unlogged: row.unlogged,
    options: row.options,
    rowSecurity: parseRowSecurity(row.rowSecurity),
    policies: row.policies,
  };
}
