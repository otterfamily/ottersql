import { isDeepStrictEqual } from "node:util";

import { referencesTable } from "../catalog/find.ts";
import type { Catalog, Column, ForeignKey, Table } from "../catalog/index.ts";
import { alterTable, identifier } from "./sql-text.ts";
import { manual, noChanges, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

const VARCHAR = /^character varying(?:\((?<length>\d+)\))?$/v;

/** The length limit of a `varchar` type as Postgres prints it, `null` for none; `undefined` for another type. */
function varcharLimit(typeSql: string): number | null | undefined {
  const match = VARCHAR.exec(typeSql);
  if (match === null) {
    return undefined;
  }
  const length = match.groups?.["length"];
  return length === undefined ? null : Number(length);
}

/**
 * Whether a column of type `before` can take type `after` without Postgres rewriting the table or
 * its indexes: a longer `varchar`, or one without a limit, or `text`, which keep every value as it
 * is and only accept more.
 */
function widens(before: string, after: string): boolean {
  const limit = varcharLimit(before);
  if (limit === undefined) {
    return false;
  }
  if (after === "text") {
    return true;
  }
  const next = varcharLimit(after);
  return next === null || (next !== undefined && limit !== null && next > limit);
}

/**
 * Whether a constraint is on `column` of `table`, in the catalog `to`: a check or a foreign key of
 * the table, or a foreign key of any table that refers to the column. Postgres checks every row
 * against them again when the column's type changes, under the exclusive lock.
 */
function constrained(table: Table, column: string, to: Catalog): boolean {
  const refersTo = (key: ForeignKey): boolean =>
    referencesTable(key, table) && key.references.columns.includes(column);
  return (
    table.checks.some((check) => check.columns.includes(column)) ||
    table.foreignKeys.some((key) => key.columns.includes(column)) ||
    to.tables.some((other) => other.foreignKeys.some((key) => refersTo(key)))
  );
}

/** A column of `table` that both catalogs have, as it was and as it is to be. */
export interface ColumnChange {
  readonly table: Table;
  readonly before: Column;
  readonly after: Column;
}

/**
 * A column's type change, when it reads and rewrites nothing: before the deploy, since the new
 * app may write the longer values. Any other change of type or collation is left to a person.
 */
export function typeChange({ table, before, after }: ColumnChange, to: Catalog): Changes {
  const object = objectName(table, after.name);
  if (!isDeepStrictEqual(before.collation, after.collation)) {
    return manual(
      object,
      "Changing a column's collation rebuilds its indexes under an exclusive lock and can reorder what they hold; add a new column, backfill it and switch to it instead",
    );
  }
  if (before.typeSql === after.typeSql) {
    return noChanges;
  }
  if (!widens(before.typeSql, after.typeSql) || constrained(table, after.name, to)) {
    return manual(
      object,
      "Changing a column's type can rewrite the table under an exclusive lock; add a new column, backfill it and switch to it instead",
    );
  }
  const statement = alterTable(
    table,
    `ALTER COLUMN ${identifier(after.name)} TYPE ${after.typeSql}`,
  );
  return only(
    step({
      kind: "widenColumn",
      object,
      statements: [statement],
      phase: "expand",
      reversal: "lossy",
      lock: "access exclusive",
      reason: "A longer varchar, or text, keeps every value as it is, so Postgres rewrites no rows",
    }),
  );
}
