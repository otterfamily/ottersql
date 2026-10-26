import { isDeepStrictEqual } from "node:util";

import type { Catalog, Table } from "../catalog/index.ts";
import { combine, manual, matchByName, noChanges, notPlanned, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { hierarchyTables } from "./table-hierarchies.ts";

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

/** What a table that `before` was, or a new one when it is `null`, needs of rules ottersql does not plan. */
function rulesOf(before: Table | null, after: Table): Changes {
  const table = `${after.schema}.${after.name}`;
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
export function tableRuleChanges(from: Catalog, to: Catalog): Changes {
  const before = new Map(from.tables.map((table) => [qualifiedName(table), table]));
  const inHierarchy = hierarchyTables(from, to);
  return combine(
    to.tables.flatMap((table) =>
      inHierarchy.has(qualifiedName(table))
        ? []
        : [rulesOf(before.get(qualifiedName(table)) ?? null, table)],
    ),
  );
}

function qualifiedName(table: Table): string {
  return `${table.schema}.${table.name}`;
}
