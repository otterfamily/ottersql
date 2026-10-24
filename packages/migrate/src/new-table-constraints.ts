import { findTable } from "@ottersql/catalog";
import type { Catalog, ForeignKey, Table } from "@ottersql/catalog";

import { addCheck } from "./constraints.ts";
import {
  alterTable,
  columnList,
  deferral,
  enforcement,
  foreignKeyDefinition,
  identifier,
} from "./sql-text.ts";
import { combine, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

function include(columns: readonly string[]): string {
  return columns.length > 0 ? ` INCLUDE ${columnList(columns)}` : "";
}

/** Table constraints as written inside `CREATE TABLE`, where there are no rows to check yet. */
export function inlineConstraints(table: Table): string[] {
  const { primaryKey } = table;
  const primary =
    primaryKey === null
      ? []
      : [
          `CONSTRAINT ${identifier(primaryKey.name)} PRIMARY KEY ${columnList(primaryKey.columns)}${include(primaryKey.include)}${deferral(primaryKey.deferral)}`,
        ];
  const unique = table.uniqueConstraints.map(
    (key) =>
      `CONSTRAINT ${identifier(key.name)} UNIQUE${key.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} ${columnList(key.columns)}${include(key.include)}${deferral(key.deferral)}`,
  );
  const checks = table.checks
    .filter((check) => check.enforcement !== "not valid")
    .map(
      (check) =>
        `CONSTRAINT ${identifier(check.name)} CHECK (${check.expression})${enforcement(check.enforcement)}`,
    );
  return [...primary, ...unique, ...checks];
}

/**
 * Whether `table` has a key a foreign key to `columns` can reference: a primary key, a unique
 * constraint or a unique index without a predicate, on the same columns in any order.
 */
function hasKey(table: Table, columns: readonly string[]): boolean {
  const same = (other: readonly string[]): boolean =>
    other.length === columns.length && other.every((column) => columns.includes(column));
  return (
    (table.primaryKey !== null && same(table.primaryKey.columns)) ||
    table.uniqueConstraints.some((key) => same(key.columns)) ||
    table.indexes.some(
      (index) =>
        index.unique &&
        index.predicate === null &&
        same(index.keys.flatMap((key) => (key.kind === "column" ? [key.column] : []))),
    )
  );
}

/**
 * What a new table adds after `CREATE TABLE`: foreign keys, once every table they may refer to
 * exists, and checks meant to skip existing rows, which `CREATE TABLE` cannot write. A foreign key
 * to a key that `from` lacks on an existing table waits until that key is added, after the deploy.
 */
export function newTableConstraints(table: Table, from: Catalog): Changes {
  const unvalidatedChecks = table.checks.filter((check) => check.enforcement === "not valid");
  const waitsForKey = (key: ForeignKey): boolean => {
    const referenced = findTable(from, key.references.schema, key.references.table);
    return referenced !== undefined && !hasKey(referenced, key.references.columns);
  };
  const foreignKeys = table.foreignKeys.map((key) =>
    step({
      kind: "addForeignKey",
      object: objectName(table, key.name),
      statements: [
        alterTable(
          table,
          `ADD CONSTRAINT ${identifier(key.name)} ${foreignKeyDefinition(key)}${enforcement(key.enforcement)}`,
        ),
      ],
      phase: waitsForKey(key) ? "contract" : "expand",
      reversal: "reversible",
      lock: "share row exclusive",
    }),
  );
  return combine([
    ...unvalidatedChecks.map((check) => addCheck(table, check)),
    only(...foreignKeys),
  ]);
}
