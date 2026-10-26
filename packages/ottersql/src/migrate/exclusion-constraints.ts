import { isDeepStrictEqual } from "node:util";

import type { Table } from "../catalog/index.ts";
import { combine, manual, matchByName, notPlanned, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Exclusion constraints a table with rows gains, loses or changes, for a person to handle: adding
 * one checks every row while writes wait. A new table is created with them, in `CREATE TABLE`.
 */
export function exclusionChanges(before: Table, after: Table): Changes {
  const { added, removed, kept } = matchByName(
    before.exclusionConstraints,
    after.exclusionConstraints,
  );
  return combine(
    [
      ...added,
      ...removed,
      ...kept
        .filter(([old, current]) => !isDeepStrictEqual(old, current))
        .map(([, current]) => current),
    ].map(({ name }) => manual(objectName(after, name), notPlanned("an exclusion constraint"))),
  );
}
