import { isDeepStrictEqual } from "node:util";

import type { Table } from "../catalog/index.ts";
import { constraintCommentChange } from "./comments.ts";
import { uncommented } from "./sql-text.ts";
import { combine, manual, matchByName, notPlanned, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Exclusion constraints a table with rows gains, loses or changes, for a person to handle: adding
 * one checks every row while writes wait. A new table is created with them, in `CREATE TABLE`.
 * One whose comment alone changed has its comment changed.
 */
export function exclusionChanges(before: Table, after: Table): Changes {
  const { added, removed, kept } = matchByName(
    before.exclusionConstraints,
    after.exclusionConstraints,
  );
  const changed = kept.filter(
    ([old, current]) => !isDeepStrictEqual(uncommented(old), uncommented(current)),
  );
  return combine([
    ...[...added, ...removed, ...changed.map(([, current]) => current)].map(({ name }) =>
      manual(objectName(after, name), notPlanned("an exclusion constraint")),
    ),
    ...kept
      .filter((pair) => !changed.includes(pair))
      .map(([old, current]) => constraintCommentChange(after, old, current)),
  ]);
}
