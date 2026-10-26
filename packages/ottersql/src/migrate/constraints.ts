import { isDeepStrictEqual } from "node:util";

import type {
  Check,
  Comment,
  Enforcement,
  ForeignKey,
  PrimaryKey,
  Table,
} from "../catalog/index.ts";
import { addCheck, addForeignKey, validateStep } from "./add-constraints.ts";
import { constraintCommentChange } from "./comments.ts";
import { exclusionChanges } from "./exclusion-constraints.ts";
import { indexBackedKey } from "./key-indexes.ts";
import type { Step } from "./plan.ts";
import {
  alterTable,
  checkDefinition,
  exceedsNameLimit,
  identifier,
  uncommented,
} from "./sql-text.ts";
import { combine, manual, matchByName, noChanges, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Checks, foreign keys, primary keys and exclusion constraints; unique keys are planned in
 * unique-keys.ts. Constraints added to a table that has rows hold for new rows first and are
 * validated in a step of their own, which blocks no writes; unique and primary keys are built as
 * indexes concurrently. Adding one tightens what the app may write, so it waits for the deploy;
 * dropping one loosens it, so it runs before.
 */
export function constraintChanges(before: Table, after: Table): Changes {
  const drop = (item: { readonly name: string }): Changes =>
    dropConstraint(after, item.name, { kind: "dropConstraint", phase: "expand" });
  return combine([
    keyedChanges(before.checks, after.checks, {
      table: after,
      drop,
      add: (check) => addCheck(after, check),
      validate: (check) => validateStep(after, check.name, "validateCheck"),
      redefine: (old, current) => replaceCheck(after, old, current),
    }),
    keyedChanges(before.foreignKeys, after.foreignKeys, {
      table: after,
      drop: (key) => dropConstraint(after, key.name, { kind: "dropForeignKey", phase: "expand" }),
      add: (key) => addForeignKey(after, key),
      validate: (key) => validateStep(after, key.name, "validateForeignKey"),
      redefine: (old, current) => replaceForeignKey(after, old, current),
    }),
    keyedChanges(primaryKeys(before), primaryKeys(after), {
      table: after,
      drop,
      add: (key) => indexBackedKey(after, key, "addPrimaryKey"),
      redefine: (_old, current) =>
        manual(
          objectName(after, current.name),
          "A changed primary key is left to a person: foreign keys often refer to it and its columns must be NOT NULL; write the change by hand",
        ),
    }),
    exclusionChanges(before, after),
  ]);
}

function primaryKeys(table: Table): PrimaryKey[] {
  return table.primaryKey === null ? [] : [table.primaryKey];
}

interface KeyedPlan<Item> {
  /** The table the constraints belong to, as `to` has it. */
  readonly table: Table;
  readonly add: (item: Item) => Changes;
  readonly drop: (item: Item) => Changes;
  /** Validates an item that was NOT VALID and is otherwise unchanged. */
  readonly validate?: (item: Item) => Changes;
  /** Plans an item whose definition changed under the same name. */
  readonly redefine: (old: Item, current: Item) => Changes;
}

/**
 * Constraints only one side has are added or dropped; one whose definition changed under the same
 * name is redefined, except one that only became validated, which is validated in place. A
 * constraint made anew takes its comment with it; one kept only has its comment changed.
 */
function keyedChanges<
  Item extends {
    readonly name: string;
    readonly enforcement?: Enforcement;
    readonly comment: Comment | null;
  },
>(before: readonly Item[], after: readonly Item[], plan: KeyedPlan<Item>): Changes {
  const { added, removed, kept } = matchByName(before, after);
  const changed = kept.filter(
    ([old, current]) => !isDeepStrictEqual(uncommented(old), uncommented(current)),
  );
  const validated = changed.filter(
    ([old, current]) =>
      plan.validate !== undefined &&
      old.enforcement === "not valid" &&
      current.enforcement === "validated" &&
      isDeepStrictEqual(
        { ...uncommented(old), enforcement: null },
        { ...uncommented(current), enforcement: null },
      ),
  );
  const redefined = changed.filter((pair) => !validated.includes(pair));
  return combine([
    ...removed.map((item) => plan.drop(item)),
    ...added.map((item) => plan.add(item)),
    ...validated.map(([, current]) => plan.validate?.(current) ?? noChanges),
    ...redefined.map(([old, current]) => plan.redefine(old, current)),
    ...kept
      .filter((pair) => !redefined.includes(pair))
      .map(([old, current]) => constraintCommentChange(plan.table, old, current)),
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

/**
 * After the deploy, drops the constraint `replaced` and renames `replacement`, which holds by then,
 * to `name`, in one transaction, so the table is never without one of them.
 */
function replaceConstraint(
  table: Table,
  names: { readonly replaced: string; readonly replacement: string; readonly name: string },
): Changes {
  const drop = alterTable(table, `DROP CONSTRAINT ${identifier(names.replaced)}`);
  const rename = alterTable(
    table,
    `RENAME CONSTRAINT ${identifier(names.replacement)} TO ${identifier(names.name)}`,
  );
  return only(
    step({
      kind: "replaceConstraint",
      object: objectName(table, names.name),
      statements: [drop, rename],
      phase: "contract",
      reversal: "lossy",
      lock: "access exclusive",
    }),
  );
}

/** The temporary names a redefined constraint goes through, or `null` when one would be too long. */
function swapNames(name: string): { readonly bridge: string; readonly next: string } | null {
  const names = { bridge: `ottersql_old_or_new_${name}`, next: `ottersql_new_${name}` };
  return exceedsNameLimit(names.bridge) ? null : names;
}

/**
 * A changed check is never missing, and neither app's writes break it. Before the deploy a check
 * that allows what either the old or the new one allows takes the old one's place, added NOT
 * VALID since every row already passes the old one; after the deploy the new one is added and
 * validated under a temporary name, then takes the bridge's place and the name.
 */
function replaceCheck(table: Table, old: Check, current: Check): Changes {
  const names = swapNames(current.name);
  if (names === null) {
    return tooLong(table, current.name);
  }
  const either = `${checkDefinition({
    expression: `(${old.expression}) OR (${current.expression})`,
    noInherit: current.noInherit,
  })} NOT VALID`;
  const addBridge = alterTable(table, `ADD CONSTRAINT ${identifier(names.bridge)} ${either}`);
  const dropOld = alterTable(table, `DROP CONSTRAINT ${identifier(old.name)}`);
  const bridge = step({
    kind: "replaceConstraint",
    object: objectName(table, current.name),
    statements: [addBridge, dropOld],
    phase: "expand",
    reversal: "lossy",
    lock: "access exclusive",
    reason: "Allows the rows of both the old and the new app until the new check is in place",
  });
  return combine([
    only(bridge),
    addCheck(table, { ...current, name: names.next }),
    replaceConstraint(table, {
      replaced: names.bridge,
      replacement: names.next,
      name: current.name,
    }),
  ]);
}

/**
 * A foreign key whose actions, match or deferral changed is checked the same way on writes, so
 * the old one holds until the new one, added and validated under a temporary name after the
 * deploy, takes its place. One that refers from or to other columns has no form both apps' rows
 * satisfy, so it is left to a person.
 */
function replaceForeignKey(table: Table, old: ForeignKey, current: ForeignKey): Changes {
  const sameColumns =
    isDeepStrictEqual(old.columns, current.columns) &&
    isDeepStrictEqual(old.references, current.references);
  if (!sameColumns) {
    return manual(
      objectName(table, current.name),
      "A foreign key that now refers from or to other columns would stop rows of the old app or of the new one while both run; change it by hand: add the new key, deploy, then drop the old one",
    );
  }
  const names = swapNames(current.name);
  if (names === null) {
    return tooLong(table, current.name);
  }
  return combine([
    addForeignKey(table, { ...current, name: names.next }),
    replaceConstraint(table, { replaced: old.name, replacement: names.next, name: current.name }),
  ]);
}

function tooLong(table: Table, name: string): Changes {
  return manual(
    objectName(table, name),
    `The temporary constraint names for "${name}" would be longer than Postgres's 63-byte names; change the constraint by hand`,
  );
}
