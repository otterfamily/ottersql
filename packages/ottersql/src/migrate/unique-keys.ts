import { isDeepStrictEqual } from "node:util";

import { referencesTable } from "../catalog/find.ts";
import type { Catalog, Table, UniqueConstraint } from "../catalog/index.ts";
import { constraintComment, constraintCommentChange } from "./comments.ts";
import { dropConstraint } from "./constraints.ts";
import { indexBackedKey, keyIndex, withoutOverlapsReason } from "./key-indexes.ts";
import { matchDefinitions, uncommented } from "./match.ts";
import {
  alterTable,
  createIndex,
  deferral,
  exceedsNameLimit,
  identifier,
  nameTooLongReason,
  temporaryName,
} from "./sql-text.ts";
import { combine, manual, objectName, only, outsideStep, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

type Direction = "widens" | "narrows";

/**
 * Unique keys. A key replaced by one on more of the same columns only loosens what may be
 * written, and one on fewer only tightens it, so the new key can be built while the old one still
 * holds and swapped in at once: before the deploy when it loosens, so the new app is never
 * refused, after it when it tightens. Other changes are left to a person.
 */
export function uniqueChanges(before: Table, after: Table, from: Catalog): Changes {
  const { added, removed, redefined, recommented } = matchDefinitions(
    before.uniqueConstraints,
    after.uniqueConstraints,
  );
  const replaced = replacements(removed, added);
  const isReplaced = (key: UniqueConstraint): boolean =>
    replaced.some(([old, current]) => old === key || current === key);
  return combine([
    ...removed
      .filter((key) => !isReplaced(key))
      .map((key) => dropConstraint(after, key.name, { kind: "dropConstraint", phase: "expand" })),
    ...added
      .filter((key) => !isReplaced(key))
      .map((key) => indexBackedKey(after, key, "addUnique")),
    ...[...replaced, ...redefined].map(([old, current]) => swapKey(after, { old, current }, from)),
    ...recommented.map(([old, current]) => constraintCommentChange(after, old, current)),
  ]);
}

/** Dropped keys paired with added ones that only widen or narrow them. */
function replacements(
  removed: readonly UniqueConstraint[],
  added: readonly UniqueConstraint[],
): (readonly [UniqueConstraint, UniqueConstraint])[] {
  const pairs: (readonly [UniqueConstraint, UniqueConstraint])[] = [];
  for (const old of removed) {
    const current = added.find(
      (key) => direction(old, key) !== null && !pairs.some(([, taken]) => taken === key),
    );
    if (current !== undefined) {
      pairs.push([old, current]);
    }
  }
  return pairs;
}

/** What a key does apart from its name and columns: included columns, NULLS NOT DISTINCT, deferral. */
function rest(key: UniqueConstraint): object {
  return { ...uncommented(key), name: null, columns: null };
}

function direction(old: UniqueConstraint, current: UniqueConstraint): Direction | null {
  if (!isDeepStrictEqual(rest(old), rest(current))) {
    return null;
  }
  if (includes(current.columns, old.columns) && current.columns.length > old.columns.length) {
    return "widens";
  }
  if (includes(old.columns, current.columns) && old.columns.length > current.columns.length) {
    return "narrows";
  }
  return null;
}

function includes(all: readonly string[], some: readonly string[]): boolean {
  return some.every((column) => all.includes(column));
}

function referenced(from: Catalog, table: Table, key: UniqueConstraint): boolean {
  return from.tables.some(({ foreignKeys }) =>
    foreignKeys.some(
      (foreignKey) =>
        referencesTable(foreignKey, table) &&
        foreignKey.references.columns.length === key.columns.length &&
        includes(foreignKey.references.columns, key.columns),
    ),
  );
}

/** Builds `current`'s index concurrently, then drops `old` and attaches the index in one transaction. */
function swapKey(
  table: Table,
  { old, current }: { readonly old: UniqueConstraint; readonly current: UniqueConstraint },
  from: Catalog,
): Changes {
  const way = direction(old, current);
  const object = objectName(table, current.name);
  if (old.withoutOverlaps || current.withoutOverlaps) {
    return manual(object, withoutOverlapsReason);
  }
  if (way === null || referenced(from, table, old)) {
    return manual(
      object,
      "A changed unique key that neither only adds columns nor only removes them, or that a foreign key refers to, cannot be swapped safely without knowing its intent; write the change by hand",
    );
  }
  const index = old.name === current.name ? temporaryName("new", current.name) : current.name;
  if (exceedsNameLimit(index)) {
    return manual(object, nameTooLongReason(`The temporary index "${index}"`, "change the key"));
  }
  return swapSteps(table, { old, current, index, way });
}

function swapSteps(
  table: Table,
  swap: {
    readonly old: UniqueConstraint;
    readonly current: UniqueConstraint;
    readonly index: string;
    readonly way: Direction;
  },
): Changes {
  const { old, current, index, way } = swap;
  const phase = way === "widens" ? "expand" : "contract";
  const build = createIndex(table, { ...keyIndex(current), name: index }, true);
  const drop = alterTable(table, `DROP CONSTRAINT ${identifier(old.name)}`);
  const attach = `ADD CONSTRAINT ${identifier(current.name)} UNIQUE USING INDEX ${identifier(index)}${deferral(current.deferral)}`;
  return only(
    outsideStep({
      kind: "createIndex",
      object: objectName(table, index),
      statements: [build],
      cleanup: { schema: table.schema, name: index },
      phase,
      reversal: "reversible",
      lock: "share update exclusive",
    }),
    step({
      kind: "addUnique",
      object: objectName(table, current.name),
      statements: [drop, alterTable(table, attach), ...constraintComment(table, current)],
      phase,
      reversal: way === "widens" ? "lossy" : "reversible",
      lock: "access exclusive",
      reason:
        "The new key takes the old one's place in one transaction, so uniqueness never lapses",
    }),
  );
}
