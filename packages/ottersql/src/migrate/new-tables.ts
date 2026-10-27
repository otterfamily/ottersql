import { findTable } from "../catalog/find.ts";
import type { Catalog, ForeignKey, Table } from "../catalog/index.ts";
import { addCheck, addForeignKey } from "./add-constraints.ts";
import { constraintComment, indexComment, initialComment } from "./comments.ts";
import {
  alterTable,
  checkDefinition,
  columnDefinition,
  columnList,
  columnSqlName,
  createIndex,
  createSequence,
  deferral,
  enforcement,
  foreignKeyDefinition,
  identifier,
  keyColumnList,
  qualified,
  setStorage,
  storageParameters,
} from "./sql-text.ts";
import { combine, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { unplannedUse, usesUnplanned } from "./unplanned-uses.ts";

/**
 * A table `to` adds: created whole with its constraints, unless it uses a type or collation the
 * plan leaves to a person (`unplanned`), which must exist first.
 */
export function newTable(table: Table, from: Catalog, unplanned: ReadonlySet<string>): Changes {
  const used = unplannedUse(table.columns, unplanned);
  return used === null
    ? combine([createTable(table), newTableConstraints(table, from)])
    : usesUnplanned(objectName(table), used, "create the table");
}

/** The comments of a new table, its columns, and the constraints and indexes `CREATE TABLE` makes. */
function comments(table: Table): string[] {
  const name = qualified(table.schema, table.name);
  const inline = [
    ...(table.primaryKey === null ? [] : [table.primaryKey]),
    ...table.uniqueConstraints,
    ...table.checks.filter((check) => check.enforcement !== "not valid"),
    ...table.exclusionConstraints,
  ];
  return [
    ...initialComment("TABLE", name, table.comment),
    ...table.columns.flatMap((column) =>
      initialComment("COLUMN", columnSqlName(table, column.name), column.comment),
    ),
    ...inline.flatMap((constraint) => constraintComment(table, constraint)),
    ...table.indexes.flatMap((index) => indexComment(table, index)),
  ];
}

/** A new table has no rows and no app using it yet, so it is created whole, indexes included. */
function createTable(table: Table): Changes {
  const definitions = [
    ...table.columns.map((column) => columnDefinition(column)),
    ...inlineConstraints(table),
  ];
  const storage = table.columns.flatMap((column) => setStorage(column));
  const storageStatements = storage.length === 0 ? [] : [alterTable(table, storage.join(", "))];
  const sequences = table.columns.flatMap((column) =>
    column.value.kind === "sequence" ? [{ column: column.name, ...column.value.sequence }] : [],
  );
  return only(
    step({
      kind: "createTable",
      object: objectName(table),
      statements: [
        ...sequences.map((sequence) => createSequence(sequence)),
        `CREATE ${table.unlogged ? "UNLOGGED " : ""}TABLE ${qualified(table.schema, table.name)} (${definitions.join(", ")})${storageParameters(table.options)}`,
        ...storageStatements,
        ...sequences.map(
          (sequence) =>
            `ALTER SEQUENCE ${qualified(sequence.schema, sequence.name)} OWNED BY ${columnSqlName(table, sequence.column)}`,
        ),
        ...table.indexes.map((index) => createIndex(table, index, false)),
        ...comments(table),
      ],
      phase: "expand",
      reversal: "lossy",
      lock: "none",
    }),
  );
}

function include(columns: readonly string[]): string {
  return columns.length > 0 ? ` INCLUDE ${columnList(columns)}` : "";
}

/** Table constraints as written inside `CREATE TABLE`, where there are no rows to check yet. */
function inlineConstraints(table: Table): string[] {
  const { primaryKey } = table;
  const primary =
    primaryKey === null
      ? []
      : [
          `CONSTRAINT ${identifier(primaryKey.name)} PRIMARY KEY ${keyColumnList(primaryKey)}${include(primaryKey.include)}${deferral(primaryKey.deferral)}`,
        ];
  const unique = table.uniqueConstraints.map(
    (key) =>
      `CONSTRAINT ${identifier(key.name)} UNIQUE${key.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} ${keyColumnList(key)}${include(key.include)}${deferral(key.deferral)}`,
  );
  const checks = table.checks
    .filter((check) => check.enforcement !== "not valid")
    .map(
      (check) =>
        `CONSTRAINT ${identifier(check.name)} ${checkDefinition(check)}${enforcement(check.enforcement)}`,
    );
  const exclusions = table.exclusionConstraints.map(
    ({ name, definition }) => `CONSTRAINT ${identifier(name)} ${definition}`,
  );
  return [...primary, ...unique, ...checks, ...exclusions];
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
 * to a key that `from` lacks on an existing table waits until that key is added, after the deploy;
 * the new app has written rows by then, so it is added as for any table with rows.
 */
function newTableConstraints(table: Table, from: Catalog): Changes {
  const unvalidatedChecks = table.checks.filter((check) => check.enforcement === "not valid");
  const waitsForKey = (key: ForeignKey): boolean => {
    const referenced = findTable(from, key.references.schema, key.references.table);
    return referenced !== undefined && !hasKey(referenced, key.references.columns);
  };
  const foreignKeys = table.foreignKeys.map((key) =>
    waitsForKey(key) ? addForeignKey(table, key) : addToEmptyTable(table, key),
  );
  return combine([...unvalidatedChecks.map((check) => addCheck(table, check)), ...foreignKeys]);
}

/** A foreign key of a table created in the same run, before the app writes to it: nothing to check yet. */
function addToEmptyTable(table: Table, key: ForeignKey): Changes {
  const definition = `${foreignKeyDefinition(key)}${enforcement(key.enforcement)}`;
  const statement = alterTable(table, `ADD CONSTRAINT ${identifier(key.name)} ${definition}`);
  return only(
    step({
      kind: "addForeignKey",
      object: objectName(table, key.name),
      statements: [statement, ...constraintComment(table, key)],
      phase: "expand",
      reversal: "reversible",
      lock: "share row exclusive",
    }),
  );
}
