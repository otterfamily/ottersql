import type { Table } from "../catalog/index.ts";
import { constraintCommentChange } from "./comments.ts";
import { matchDefinitions } from "./match.ts";
import { combine, manual, notPlanned, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Exclusion constraints a table with rows gains, loses or changes, for a person to handle: adding
 * one checks every row while writes wait. A new table is created with them, in `CREATE TABLE`.
 * One whose comment alone changed has its comment changed.
 */
export function exclusionChanges(before: Table, after: Table): Changes {
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
