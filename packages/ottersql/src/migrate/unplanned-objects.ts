import { isDeepStrictEqual } from "node:util";

import { nameKey } from "../catalog/find.ts";
import type { Catalog } from "../catalog/index.ts";
import { combine, manual, notPlanned, objectName } from "./changes.ts";
import type { Changes } from "./changes.ts";

interface Named {
  readonly schema: string;
  readonly name: string;
}

/** Kinds of objects ottersql reads but does not plan changes to yet. */
const unplanned = [
  ["extensions", "an extension"],
  ["sequences", "a sequence"],
  ["domains", "a domain"],
  ["ranges", "a range type"],
  ["collations", "a collation"],
  ["textSearchConfigurations", "a text search configuration"],
  ["textSearchDictionaries", "a text search dictionary"],
  ["views", "a view"],
  ["routines", "a function"],
] as const satisfies readonly (readonly [keyof Catalog, string])[];

function keyOf(item: Named): string {
  return nameKey(item.schema, item.name);
}

/** The `nameKey`s of the domains, range types with their multiranges, and collations of `catalog`. */
function typesAndCollations(catalog: Catalog): string[] {
  return [
    ...catalog.domains.map(keyOf),
    ...catalog.ranges.flatMap((range) => [keyOf(range), nameKey(range.schema, range.multirange)]),
    ...catalog.collations.map(keyOf),
  ];
}

/**
 * The types and collations `to` adds that the plan leaves to a person, as `nameKey`s. Something
 * that uses one cannot be created until a person has created it.
 */
export function unplannedAdditions(from: Catalog, to: Catalog): ReadonlySet<string> {
  const existing = new Set(typesAndCollations(from));
  return new Set(typesAndCollations(to).filter((name) => !existing.has(name)));
}

/** Reports every added, removed or changed object of a kind the planner does not handle. */
export function unplannedChanges(from: Catalog, to: Catalog): Changes {
  return combine(
    unplanned.flatMap(([property, label]) =>
      differingNames(from[property], to[property]).map((name) => manual(name, notPlanned(label))),
    ),
  );
}

/** The objects of one name on each side; overloaded functions share a name. */
interface Sides {
  readonly name: string;
  readonly before: Named[];
  readonly after: Named[];
}

/** Names of objects only one side has, or that differ; overloaded functions share a name. */
function differingNames(before: readonly Named[], after: readonly Named[]): string[] {
  const byName = new Map<string, Sides>();
  const group = (item: Named): Sides => {
    const key = keyOf(item);
    const found = byName.get(key) ?? { name: objectName(item), before: [], after: [] };
    byName.set(key, found);
    return found;
  };
  for (const item of before) {
    group(item).before.push(item);
  }
  for (const item of after) {
    group(item).after.push(item);
  }
  return [...byName.values()]
    .filter((sides) => !isDeepStrictEqual(sides.before, sides.after))
    .map(({ name }) => name);
}
