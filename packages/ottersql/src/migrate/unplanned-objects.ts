import { isDeepStrictEqual } from "node:util";

import type { Catalog } from "../catalog/index.ts";
import { combine, manual, notPlanned } from "./steps.ts";
import type { Changes } from "./steps.ts";

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

function nameOf(item: Named): string {
  return `${item.schema}.${item.name}`;
}

/** The domains, range types with their multiranges, and collations of `catalog`, by name. */
function typesAndCollations(catalog: Catalog): string[] {
  return [
    ...catalog.domains.map(nameOf),
    ...catalog.ranges.flatMap((range) => [nameOf(range), `${range.schema}.${range.multirange}`]),
    ...catalog.collations.map(nameOf),
  ];
}

/**
 * The types and collations `to` adds that the plan leaves to a person. Something that uses one
 * cannot be created until a person has created it.
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

/** Names of objects only one side has, or that differ; overloaded functions share a name. */
function differingNames(before: readonly Named[], after: readonly Named[]): string[] {
  const byName = new Map<string, { readonly before: Named[]; readonly after: Named[] }>();
  const group = (item: Named): { readonly before: Named[]; readonly after: Named[] } => {
    const name = nameOf(item);
    const found = byName.get(name) ?? { before: [], after: [] };
    byName.set(name, found);
    return found;
  };
  for (const item of before) {
    group(item).before.push(item);
  }
  for (const item of after) {
    group(item).after.push(item);
  }
  return [...byName]
    .filter(([, sides]) => !isDeepStrictEqual(sides.before, sides.after))
    .map(([name]) => name);
}
