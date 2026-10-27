import type { Check, Comment, Enforcement, ForeignKey, Table } from "../catalog/index.ts";
import { constraintComment } from "./comments.ts";
import {
  alterTable,
  checkDefinition,
  enforcement,
  foreignKeyDefinition,
  identifier,
} from "./sql-text.ts";
import { combine, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

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
