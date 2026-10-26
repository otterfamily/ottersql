import type { Relation } from "../catalog/by-oid.ts";
import { findTable } from "../catalog/find.ts";
import type { Catalog, TriggerEvent } from "../catalog/index.ts";
import { nodesOfType, scalar } from "./node-tree.ts";
import type { NodeObject } from "./node-tree.ts";
import type { NullabilityFacts } from "./nullability.ts";

/** Whether the catalog proves a column of `relation` never null (see `NullabilityFacts`). */
function isNotNullColumn(
  catalog: Catalog,
  {
    relation,
    attnum,
    ownRowsOnly,
  }: {
    readonly relation: Relation | undefined;
    readonly attnum: number;
    readonly ownRowsOnly: boolean;
  },
): boolean {
  const name = relation?.columns.get(attnum);
  const table =
    relation === undefined ? undefined : findTable(catalog, relation.schema, relation.name);
  if (table === undefined || name === undefined) {
    return false;
  }
  return (
    table.columns.some(
      (column) =>
        column.name === name && column.notNull && (ownRowsOnly || !column.notNullNoInherit),
    ) ||
    table.checks.some(
      (check) => check.notNullColumns.includes(name) && (ownRowsOnly || !check.noInherit),
    )
  );
}

/** Whether `relation` has a BEFORE ROW trigger on `event`. */
function hasBeforeRowTrigger(
  catalog: Catalog,
  relation: Relation | undefined,
  event: TriggerEvent,
): boolean {
  const table =
    relation === undefined ? undefined : findTable(catalog, relation.schema, relation.name);
  return (
    table?.triggers.some(
      (trigger) =>
        trigger.timing === "before" && trigger.forEachRow && trigger.events.includes(event),
    ) ?? false
  );
}

/** What the catalog says of the relations a statement reads and writes, by oid. */
export function relationFacts(
  catalog: Catalog,
  relations: ReadonlyMap<number, Relation>,
): Pick<NullabilityFacts, "hasBeforeRowTrigger" | "isNotNullColumn"> {
  return {
    isNotNullColumn: (relationOid, attnum, ownRowsOnly) =>
      isNotNullColumn(catalog, { relation: relations.get(relationOid), attnum, ownRowsOnly }),
    hasBeforeRowTrigger: (relationOid, event) =>
      hasBeforeRowTrigger(catalog, relations.get(relationOid), event),
  };
}

/** The oids of the tables, views and other relations an analyzed statement reads or writes. */
export function relationOids(tree: NodeObject | null): number[] {
  return nodesOfType(tree ?? undefined, "RANGETBLENTRY").flatMap((entry) => {
    const relid = scalar(entry, "relid");
    return relid === undefined ? [] : [Number(relid)];
  });
}
