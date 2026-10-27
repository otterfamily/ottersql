import { isDeepStrictEqual } from "node:util";

import type { Catalog, Table } from "../catalog/index.ts";
import { columnChanges } from "./columns.ts";
import { commentChange } from "./comments.ts";
import { constraintChanges } from "./constraints.ts";
import { indexChanges } from "./indexes.ts";
import { qualified } from "./sql-text.ts";
import { combine, manual, noChanges, notPlanned, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { uniqueChanges } from "./unique-keys.ts";

/** The catalogs a plan goes between, and what it leaves to a person that new objects may use. */
export interface Sides {
  readonly from: Catalog;
  readonly to: Catalog;
  readonly unplanned: ReadonlySet<string>;
}

/** The changes from `before`, a table of the catalog `from`, to `after`, one of `to`. */
export function changeTable(before: Table, after: Table, { from, to, unplanned }: Sides): Changes {
  const storageChanged =
    before.unlogged !== after.unlogged || !isDeepStrictEqual(before.options, after.options);
  return combine([
    storageChanged
      ? manual(
          objectName(after),
          notPlanned("whether a table is logged, or to its storage parameters,"),
        )
      : noChanges,
    columnChanges(before, after, { to, unplanned }),
    constraintChanges(before, after),
    uniqueChanges(before, after, from),
    indexChanges(before, after),
    commentChange({
      on: "TABLE",
      object: objectName(after),
      name: qualified(after.schema, after.name),
      before: before.comment,
      after: after.comment,
    }),
  ]);
}
