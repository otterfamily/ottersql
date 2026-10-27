import { isDeepStrictEqual } from "node:util";

import type { Comment, Enforcement, PrimaryKey, Table } from "../../catalog/index.ts";
import { combine, manual, noChanges, notPlanned, objectName } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { constraintCommentChange } from "./comments.ts";
import {
  addCheck,
  addForeignKey,
  dropConstraint,
  replaceCheck,
  replaceForeignKey,
  validateStep,
} from "./constraint-steps.ts";
import { indexBackedKey } from "./index-backed-keys.ts";
import { matchDefinitions, uncommented } from "./match.ts";

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
  const { added, removed, redefined: changed, recommented } = matchDefinitions(before, after);
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
    ...recommented.map(([old, current]) => constraintCommentChange(plan.table, old, current)),
  ]);
}

/**
 * Exclusion constraints a table with rows gains, loses or changes, for a person to handle: adding
 * one checks every row while writes wait. A new table is created with them, in `CREATE TABLE`.
 * One whose comment alone changed has its comment changed.
 */
function exclusionChanges(before: Table, after: Table): Changes {
  const { added, removed, redefined, recommented } = matchDefinitions(
    before.exclusionConstraints,
    after.exclusionConstraints,
  );
  return combine([
    ...[...added, ...removed, ...redefined.map(([, current]) => current)].map(({ name }) =>
      manual(objectName(after, name), notPlanned("an exclusion constraint")),
    ),
    ...recommented.map(([old, current]) => constraintCommentChange(after, old, current)),
  ]);
}
