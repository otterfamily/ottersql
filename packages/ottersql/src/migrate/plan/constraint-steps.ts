import { isDeepStrictEqual } from "node:util";

import type { Check, Comment, Enforcement, ForeignKey, Table } from "../../catalog/index.ts";
import type { Step } from "../plan.ts";
import { combine, manual, objectName, only, step } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { constraintComment } from "./comments.ts";
import {
  alterTable,
  checkDefinition,
  enforcement,
  exceedsNameLimit,
  foreignKeyDefinition,
  identifier,
  nameTooLongReason,
  temporaryName,
} from "./sql-text.ts";

interface Addition {
  readonly table: Table;
  readonly name: string;
  readonly definition: string;
  readonly kind: "check" | "foreignKey";
  readonly enforcement: Enforcement;
  readonly comment: Comment | null;
}

/**
 * Adds a constraint for new rows only, then validates existing rows unless it is meant to stay
 * unvalidated. Its comment goes with it, and stays through a later rename.
 */
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
      ...constraintComment(table, addition),
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
export function validateStep(
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
    definition: checkDefinition(check),
    kind: "check",
    enforcement: check.enforcement,
    comment: check.comment,
  });
}

export function addForeignKey(table: Table, key: ForeignKey): Changes {
  return addThenValidate({
    table,
    name: key.name,
    definition: foreignKeyDefinition(key),
    kind: "foreignKey",
    enforcement: key.enforcement,
    comment: key.comment,
  });
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
  const names = { bridge: temporaryName("old_or_new", name), next: temporaryName("new", name) };
  return exceedsNameLimit(names.bridge) ? null : names;
}

/**
 * A changed check is never missing, and neither app's writes break it. Before the deploy a check
 * that allows what either the old or the new one allows takes the old one's place, added NOT
 * VALID since every row already passes the old one; after the deploy the new one is added and
 * validated under a temporary name, then takes the bridge's place and the name.
 */
export function replaceCheck(table: Table, old: Check, current: Check): Changes {
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
export function replaceForeignKey(table: Table, old: ForeignKey, current: ForeignKey): Changes {
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
    nameTooLongReason(`The temporary constraint names for "${name}"`, "change the constraint"),
  );
}
