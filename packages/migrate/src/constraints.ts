import { isDeepStrictEqual } from "node:util";

import type {
  Check,
  Enforcement,
  ForeignKey,
  Index,
  PrimaryKey,
  Table,
  UniqueConstraint,
} from "@ottersql/catalog";

import {
  columnList,
  createIndex,
  deferral,
  enforcement,
  foreignKeyDefinition,
  identifier,
} from "./sql-text.ts";
import { combine, matchByName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { alterTable, dropIndexStatement, objectName } from "./table-sql.ts";

/**
 * Constraints added to a table that has rows hold for new rows first and are validated in a step of
 * their own, which blocks no writes; unique and primary keys are built as indexes concurrently.
 * Adding one tightens what the app may write, so it waits for the deploy; dropping one loosens it,
 * so it runs before.
 */
export function constraintChanges(before: Table, after: Table): Changes {
  const drop = (item: { readonly name: string }): Changes => dropConstraint(after, item.name);
  return combine([
    keyedChanges(before.checks, after.checks, { drop, add: (check) => addCheck(after, check) }),
    keyedChanges(before.foreignKeys, after.foreignKeys, {
      drop,
      add: (key) => addForeignKey(after, key),
    }),
    keyedChanges(before.uniqueConstraints, after.uniqueConstraints, {
      drop,
      add: (key) => indexBackedKey(after, key, "addUnique"),
    }),
    keyedChanges(primaryKeys(before), primaryKeys(after), {
      drop,
      add: (key) => indexBackedKey(after, key, "addPrimaryKey"),
    }),
  ]);
}

function primaryKeys(table: Table): PrimaryKey[] {
  return table.primaryKey === null ? [] : [table.primaryKey];
}

/** A constraint whose definition changed under the same name is dropped and added again. */
function keyedChanges<Item extends { readonly name: string }>(
  before: readonly Item[],
  after: readonly Item[],
  plan: { readonly add: (item: Item) => Changes; readonly drop: (item: Item) => Changes },
): Changes {
  const { added, removed, kept } = matchByName(before, after);
  const changed = kept.filter(([old, current]) => !isDeepStrictEqual(old, current));
  return combine([
    ...[...removed, ...changed.map(([old]) => old)].map((item) => plan.drop(item)),
    ...[...added, ...changed.map(([, current]) => current)].map((item) => plan.add(item)),
  ]);
}

function dropConstraint(table: Table, name: string): Changes {
  const statement = alterTable(table, `DROP CONSTRAINT ${identifier(name)}`);
  return only(
    step({
      kind: "dropConstraint",
      object: objectName(table, name),
      statements: [statement],
      phase: "expand",
      reversal: "reversible",
      lock: "access exclusive",
    }),
  );
}

interface Addition {
  readonly table: Table;
  readonly name: string;
  readonly definition: string;
  readonly kind: "check" | "foreignKey";
  readonly enforcement: Enforcement;
}

/** Adds a constraint for new rows only, then validates existing rows unless it is meant to stay unvalidated. */
function addThenValidate(addition: Addition): Changes {
  const { table, name, kind } = addition;
  const object = objectName(table, name);
  const unvalidated =
    addition.enforcement === "validated" ? " NOT VALID" : enforcement(addition.enforcement);
  const add = step({
    kind: kind === "check" ? "addCheck" : "addForeignKey",
    object,
    statements: [
      alterTable(table, `ADD CONSTRAINT ${identifier(name)} ${addition.definition}${unvalidated}`),
    ],
    phase: "contract",
    reversal: "reversible",
    lock: kind === "check" ? "access exclusive" : "share row exclusive",
  });
  const validate = step({
    kind: kind === "check" ? "validateCheck" : "validateForeignKey",
    object,
    statements: [alterTable(table, `VALIDATE CONSTRAINT ${identifier(name)}`)],
    phase: "contract",
    reversal: "reversible",
    lock: "share update exclusive",
    reason: "Checking existing rows takes a lock that lets reads and writes go on",
  });
  return addition.enforcement === "validated" ? only(add, validate) : only(add);
}

function addCheck(table: Table, check: Check): Changes {
  return addThenValidate({
    table,
    name: check.name,
    definition: `CHECK (${check.expression})`,
    kind: "check",
    enforcement: check.enforcement,
  });
}

function addForeignKey(table: Table, key: ForeignKey): Changes {
  return addThenValidate({
    table,
    name: key.name,
    definition: foreignKeyDefinition(key),
    kind: "foreignKey",
    enforcement: key.enforcement,
  });
}

function keyIndex(key: PrimaryKey | UniqueConstraint): Index {
  return {
    name: key.name,
    method: "btree",
    unique: true,
    nullsNotDistinct: "nullsNotDistinct" in key && key.nullsNotDistinct,
    keys: key.columns.map((column) => ({
      kind: "column",
      column,
      order: "asc",
      nulls: "last",
      operatorClass: null,
      collation: null,
    })),
    include: key.include,
    predicate: null,
  };
}

/** Builds the key's index concurrently, then turns it into the constraint, which only takes a moment. */
function indexBackedKey(
  table: Table,
  key: PrimaryKey | UniqueConstraint,
  kind: "addUnique" | "addPrimaryKey",
): Changes {
  const object = objectName(table, key.name);
  const constraint = kind === "addUnique" ? "UNIQUE" : "PRIMARY KEY";
  const name = identifier(key.name);
  const build = createIndex(table, keyIndex(key), true);
  const add = alterTable(
    table,
    `ADD CONSTRAINT ${name} ${constraint} USING INDEX ${name}${deferral(key.deferral)}`,
  );
  return only(
    step({
      kind: "createIndex",
      object,
      statements: [build],
      cleanup: [dropIndexStatement(table, key.name)],
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
      transaction: "outside",
    }),
    step({
      kind,
      object,
      statements: [add],
      phase: "contract",
      reversal: "reversible",
      lock: "access exclusive",
    }),
  );
}

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
 * What a new table adds after `CREATE TABLE`: foreign keys, once every table they may refer to
 * exists, and checks meant to skip existing rows, which `CREATE TABLE` cannot write.
 */
export function newTableConstraints(table: Table): Changes {
  const unvalidatedChecks = table.checks.filter((check) => check.enforcement === "not valid");
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
      phase: "expand",
      reversal: "reversible",
      lock: "share row exclusive",
    }),
  );
  return combine([
    ...unvalidatedChecks.map((check) => addCheck(table, check)),
    only(...foreignKeys),
  ]);
}
