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
  const names = new Set([...before, ...after].map(({ schema, name }) => `${schema}.${name}`));
  return [...names].filter((name) => {
    const old = before.filter((item) => `${item.schema}.${item.name}` === name);
    const current = after.filter((item) => `${item.schema}.${item.name}` === name);
    return !isDeepStrictEqual(old, current);
  });
}
