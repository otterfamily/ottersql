import { isDeepStrictEqual } from "node:util";

import { nameKey } from "../catalog/find.ts";
import type { Catalog, Table } from "../catalog/index.ts";
import { combine, manual, noChanges, notPlanned, objectName } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { matchByName } from "./match.ts";
import { inHierarchy } from "./table-hierarchies.ts";

/** The names of the items only one side has, or that differ between the sides. */
function differing<Item extends { readonly name: string }>(
  before: readonly Item[],
  after: readonly Item[],
): string[] {
  const { added, removed, kept } = matchByName(before, after);
  return [
    ...added.map(({ name }) => name),
    ...kept
      .filter(([old, current]) => !isDeepStrictEqual(old, current))
      .map(([, { name }]) => name),
    ...removed.map(({ name }) => name),
  ];
}

/** What a table that `before` was, or a new one when it is `null`, needs of triggers, row-level security and policies, which ottersql does not plan. */
function triggersAndPoliciesOf(before: Table | null, after: Table): Changes {
  const table = objectName(after);
  const security = before?.rowSecurity ?? "disabled";
  return combine([
    security === after.rowSecurity ? noChanges : manual(table, notPlanned("row-level security")),
    ...differing(before?.policies ?? [], after.policies).map((name) =>
      manual(objectName(after, name), notPlanned("a policy")),
    ),
    ...differing(before?.triggers ?? [], after.triggers).map((name) =>
      manual(objectName(after, name), notPlanned("a trigger")),
    ),
  ]);
}

/**
 * The triggers, row-level security and policies of tables that are new or kept, which the plan
 * leaves to a person; a dropped table takes its own with it. Tables in a hierarchy are left to a
 * person whole, in table-hierarchies.ts.
 */
export function triggerAndPolicyChanges(from: Catalog, to: Catalog): Changes {
  const before = new Map(from.tables.map((table) => [nameKey(table.schema, table.name), table]));
  const hierarchical = inHierarchy(from, to);
  return combine(
    to.tables.flatMap((table) =>
      hierarchical(table)
        ? []
        : [triggersAndPoliciesOf(before.get(nameKey(table.schema, table.name)) ?? null, table)],
    ),
  );
}
