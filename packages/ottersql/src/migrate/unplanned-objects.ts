import { isDeepStrictEqual } from "node:util";

import type { Catalog } from "../catalog/index.ts";
import { combine, manual } from "./steps.ts";
import type { Changes } from "./steps.ts";

interface Named {
  readonly schema: string;
  readonly name: string;
}

/** Kinds of objects ottersql reads but does not plan changes to yet. */
const unplanned = [
  ["domains", "domain"],
  ["ranges", "range type"],
  ["views", "view"],
  ["routines", "function"],
] as const satisfies readonly (readonly [keyof Catalog, string])[];

/** Reports every added, removed or changed object of a kind the planner does not handle. */
export function unplannedChanges(from: Catalog, to: Catalog): Changes {
  return combine(
    unplanned.flatMap(([property, label]) =>
      differingNames(from[property], to[property]).map((name) =>
        manual(name, `ottersql does not plan changes to a ${label} yet; write this change by hand`),
      ),
    ),
  );
}

/** Names of objects only one side has, or that differ; overloaded functions share a name. */
function differingNames(before: readonly Named[], after: readonly Named[]): string[] {
  const byName = new Map<string, { readonly before: Named[]; readonly after: Named[] }>();
  const group = (item: Named): { readonly before: Named[]; readonly after: Named[] } => {
    const name = `${item.schema}.${item.name}`;
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
