import type { Table } from "@ottersql/catalog";

import { identifier, qualified } from "./sql-text.ts";

/** `schema.table.name`, as plans name what a step changes. */
export function objectName(table: Table, name: string): string {
  return `${table.schema}.${table.name}.${name}`;
}

export function alterTable(table: Table, action: string): string {
  return `ALTER TABLE ${qualified(table.schema, table.name)} ${action}`;
}

export function columnSqlName(table: Table, column: string): string {
  return `${qualified(table.schema, table.name)}.${identifier(column)}`;
}
