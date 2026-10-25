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

import type { Step } from "./plan.ts";
import {
  alterTable,
  createIndex,
  deferral,
  enforcement,
  foreignKeyDefinition,
  identifier,
} from "./sql-text.ts";
import {
  combine,
  manual,
  matchByName,
  noChanges,
  objectName,
  only,
  outsideStep,
  step,
} from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Constraints added to a table that has rows hold for new rows first and are validated in a step of
 * their own, which blocks no writes; unique and primary keys are built as indexes concurrently.
 * Adding one tightens what the app may write, so it waits for the deploy; dropping one loosens it,
 * so it runs before.
 */
export function constraintChanges(before: Table, after: Table): Changes {
  const drop = (item: { readonly name: string }): Changes =>
    dropConstraint(after, item.name, { kind: "dropConstraint", phase: "expand" });
  return combine([
    keyedChanges(before.checks, after.checks, {
      drop,
      add: (check) => addCheck(after, check),
      validate: (check) => validateStep(after, check.name, "validateCheck"),
    }),
    keyedChanges(before.foreignKeys, after.foreignKeys, {
      drop: (key) => dropConstraint(after, key.name, { kind: "dropForeignKey", phase: "expand" }),
      add: (key) => addForeignKey(after, key),
      validate: (key) => validateStep(after, key.name, "validateForeignKey"),
    }),
    keyedChanges(before.uniqueConstraints, after.uniqueConstraints, {
      drop,
      add: (key) => indexBackedKey(after, key, "addUnique"),
      redefine: (key) => changedKey(after, key),
    }),
    keyedChanges(primaryKeys(before), primaryKeys(after), {
      drop,
      add: (key) => indexBackedKey(after, key, "addPrimaryKey"),
      redefine: (key) => changedKey(after, key),
    }),
  ]);
}

/**
 * Whether a changed key loosens or tightens what may be written decides the safe order, and its
 * definition does not say which, so a person writes the change.
 */
function changedKey(table: Table, key: { readonly name: string }): Changes {
  return manual(
    objectName(table, key.name),
    "A changed key cannot be swapped safely without knowing its intent: keeping the old one until after the deploy fails the new app's writes if the change loosens it, and dropping it first leaves the table without it during the deploy; write the change by hand",
  );
}

function primaryKeys(table: Table): PrimaryKey[] {
  return table.primaryKey === null ? [] : [table.primaryKey];
}

interface KeyedPlan<Item> {
  readonly add: (item: Item) => Changes;
  readonly drop: (item: Item) => Changes;
  /** Validates an item that was NOT VALID and is otherwise unchanged; without it, it is re-added. */
  readonly validate?: (item: Item) => Changes;
  /** Plans an item whose definition changed; without it, the old one is dropped and the new added. */
  readonly redefine?: (item: Item) => Changes;
}

/**
 * A constraint whose definition changed under the same name is dropped and added again, except
 * one that only became validated, which is validated in place.
 */
function keyedChanges<Item extends { readonly name: string; readonly enforcement?: Enforcement }>(
  before: readonly Item[],
  after: readonly Item[],
  plan: KeyedPlan<Item>,
): Changes {
  const { added, removed, kept } = matchByName(before, after);
  const changed = kept.filter(([old, current]) => !isDeepStrictEqual(old, current));
  const validated = changed.filter(
    ([old, current]) =>
      plan.validate !== undefined &&
      old.enforcement === "not valid" &&
      current.enforcement === "validated" &&
      isDeepStrictEqual({ ...old, enforcement: null }, { ...current, enforcement: null }),
  );
  const redefined = changed.filter((pair) => !validated.includes(pair));
  const { redefine } = plan;
  const swapped = redefine === undefined ? redefined : [];
  return combine([
    ...[...removed, ...swapped.map(([old]) => old)].map((item) => plan.drop(item)),
    ...[...added, ...swapped.map(([, current]) => current)].map((item) => plan.add(item)),
    ...validated.map(([, current]) => plan.validate?.(current) ?? noChanges),
    ...(redefine === undefined ? [] : redefined.map(([, current]) => redefine(current))),
  ]);
}

/**
 * Foreign keys are dropped as a kind of their own, so that they go before the keys they reference
 * and the tables those keys belong to. Once rows that break the constraint are written, it cannot
 * be added back without changing them, so dropping it is lossy.
 */
export function dropConstraint(
  table: Table,
  name: string,
  { kind, phase }: Pick<Step, "kind" | "phase">,
): Changes {
  const statement = alterTable(table, `DROP CONSTRAINT ${identifier(name)}`);
  return only(
    step({
      kind,
      object: objectName(table, name),
      statements: [statement],
      phase,
      reversal: "lossy",
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
  if (addition.enforcement !== "validated") {
    return only(add);
  }
  const validate = validateStep(
    table,
    name,
    kind === "check" ? "validateCheck" : "validateForeignKey",
  );
  return combine([only(add), validate]);
}

/** Checks existing rows against a constraint added NOT VALID, which lets reads and writes go on. */
function validateStep(
  table: Table,
  name: string,
  kind: "validateCheck" | "validateForeignKey",
): Changes {
  const statement = alterTable(table, `VALIDATE CONSTRAINT ${identifier(name)}`);
  return only(
    step({
      kind,
      object: objectName(table, name),
      statements: [statement],
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
      reason: "Checking existing rows takes a lock that lets reads and writes go on",
    }),
  );
}

export function addCheck(table: Table, check: Check): Changes {
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
    outsideStep({
      kind: "createIndex",
      object,
      statements: [build],
      cleanup: { schema: table.schema, name: key.name },
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
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
