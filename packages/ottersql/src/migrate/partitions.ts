import { isDeepStrictEqual } from "node:util";

import type { Catalog, Table } from "../catalog/index.ts";
import { combine, manual } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * Whether `table` is partitioned or a partition. Its partitions share its columns, constraints and
 * indexes, which Postgres changes for them all through the partitioned table, and an index on it
 * cannot be built concurrently, so the planner's steps for single tables do not fit it.
 */
export function isPartitioned(table: Table): boolean {
  return table.partitionedBy !== null || table.partitionOf !== null;
}

function partitionedByName(catalog: Catalog): Map<string, Table> {
  return new Map(
    catalog.tables
      .filter((table) => isPartitioned(table))
      .map((table) => [`${table.schema}.${table.name}`, table]),
  );
}

/** Every partitioned table or partition that is added, removed or changed, for a person to handle. */
export function partitionChanges(from: Catalog, to: Catalog): Changes {
  const before = partitionedByName(from);
  const after = partitionedByName(to);
  const names = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return combine(
    names
      .filter((name) => !isDeepStrictEqual(before.get(name), after.get(name)))
      .map((name) =>
        manual(
          name,
          "ottersql does not plan partitioned tables or their partitions yet; write this change by hand",
        ),
      ),
  );
}
