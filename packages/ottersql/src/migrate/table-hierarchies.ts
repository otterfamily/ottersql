import { isDeepStrictEqual } from "node:util";

import type { Catalog, Table } from "../catalog/index.ts";
import { combine, manual } from "./steps.ts";
import type { Changes } from "./steps.ts";

// A table in a hierarchy shares its columns, constraints and indexes with the others, and Postgres
// changes them for the whole hierarchy through the parent; an index on a partitioned table cannot
// be built concurrently either. The planner's steps for single tables do not fit them.
const partitionReason =
  "ottersql does not plan partitioned tables or their partitions yet; write this change by hand";
const inheritanceReason =
  "ottersql does not plan tables that inherit from others or are inherited from (INHERITS) yet; write this change by hand";

interface Member {
  readonly table: Table;
  readonly reason: string;
}

function nameOf(table: { readonly schema: string; readonly name: string }): string {
  return `${table.schema}.${table.name}`;
}

/** The tables of `catalog` that are partitioned, partitions, inherit from another or are inherited from. */
function members(catalog: Catalog): Map<string, Member> {
  const parents = new Set(catalog.tables.flatMap((table) => table.inherits.map(nameOf)));
  return new Map(
    catalog.tables.flatMap((table): [string, Member][] => {
      if (table.partitionedBy !== null || table.partitionOf !== null) {
        return [[nameOf(table), { table, reason: partitionReason }]];
      }
      return table.inherits.length > 0 || parents.has(nameOf(table))
        ? [[nameOf(table), { table, reason: inheritanceReason }]]
        : [];
    }),
  );
}

/** The names of the tables in a hierarchy on either side, which the planner leaves to `hierarchyChanges`. */
export function hierarchyTables(from: Catalog, to: Catalog): ReadonlySet<string> {
  return new Set([...members(from).keys(), ...members(to).keys()]);
}

function tablesByName(catalog: Catalog): Map<string, Table> {
  return new Map(catalog.tables.map((table) => [nameOf(table), table]));
}

/** Every table in a hierarchy that is added, removed or changed, for a person to handle. */
export function hierarchyChanges(from: Catalog, to: Catalog): Changes {
  const before = tablesByName(from);
  const after = tablesByName(to);
  // A table's reason is the one of its newer side.
  const all = new Map([...members(from), ...members(to)]);
  return combine(
    [...all]
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .filter(([name]) => !isDeepStrictEqual(before.get(name), after.get(name)))
      .map(([name, { reason }]) => manual(name, reason)),
  );
}
