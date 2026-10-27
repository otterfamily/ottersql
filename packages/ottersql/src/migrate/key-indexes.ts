import type { Index, PrimaryKey, Table, UniqueConstraint } from "../catalog/index.ts";
import { constraintComment } from "./comments.ts";
import { alterTable, createIndex, deferral, identifier } from "./sql-text.ts";
import { manual, objectName, only, outsideStep, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

/** Why a key WITHOUT OVERLAPS is not added to or changed on a table with rows by the planner. */
export const withoutOverlapsReason =
  "ottersql adds a key to a table with rows through a unique B-tree index built concurrently, which a key WITHOUT OVERLAPS cannot use; write this change by hand";

export function keyIndex(key: PrimaryKey | UniqueConstraint): Index {
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
    options: [],
    comment: null,
  };
}

/** Builds the key's index concurrently, then turns it into the constraint, which only takes a moment. */
export function indexBackedKey(
  table: Table,
  key: PrimaryKey | UniqueConstraint,
  kind: "addUnique" | "addPrimaryKey",
): Changes {
  const object = objectName(table, key.name);
  if (key.withoutOverlaps) {
    return manual(object, withoutOverlapsReason);
  }
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
      statements: [add, ...constraintComment(table, key)],
      phase: "contract",
      reversal: "reversible",
      lock: "access exclusive",
    }),
  );
}
