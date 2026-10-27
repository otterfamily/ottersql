import { isDeepStrictEqual } from "node:util";

import { nameKey } from "../catalog/find.ts";
import type { Comment, QualifiedName } from "../catalog/index.ts";

/** The items `to` adds, the ones `from` has that `to` removes, and the pairs both keep. */
interface Matched<Item> {
  readonly added: readonly Item[];
  readonly removed: readonly Item[];
  readonly kept: readonly (readonly [Item, Item])[];
}

function matchBy<Item>(
  from: readonly Item[],
  to: readonly Item[],
  key: (item: Item) => string,
): Matched<Item> {
  const fromByKey = new Map(from.map((item) => [key(item), item]));
  const toKeys = new Set(to.map((item) => key(item)));
  return {
    added: to.filter((item) => !fromByKey.has(key(item))),
    removed: from.filter((item) => !toKeys.has(key(item))),
    kept: to.flatMap((item) => {
      const before = fromByKey.get(key(item));
      return before === undefined ? [] : [[before, item] as const];
    }),
  };
}

/** Objects of one table or schema, matched by name. */
export function matchByName<Item extends { readonly name: string }>(
  from: readonly Item[],
  to: readonly Item[],
): Matched<Item> {
  return matchBy(from, to, (item) => item.name);
}

/** Objects of any schema, matched by schema and name. */
export function matchByQualifiedName<Item extends QualifiedName>(
  from: readonly Item[],
  to: readonly Item[],
): Matched<Item> {
  return matchBy(from, to, (item) => nameKey(item.schema, item.name));
}

/** `item` with its comment left out, to compare what it does apart from what it says. */
export function uncommented<Item extends { readonly comment: Comment | null }>(item: Item): Item {
  return { ...item, comment: null };
}

/**
 * `matchByName`, with the kept pairs split into those `redefined`, which differ in more than their
 * comment, and those `recommented`, which differ in their comment at most.
 */
export function matchDefinitions<
  Item extends { readonly name: string; readonly comment: Comment | null },
>(
  from: readonly Item[],
  to: readonly Item[],
): Omit<Matched<Item>, "kept"> & {
  readonly redefined: readonly (readonly [Item, Item])[];
  readonly recommented: readonly (readonly [Item, Item])[];
} {
  const { added, removed, kept } = matchByName(from, to);
  const same = ([old, current]: readonly [Item, Item]): boolean =>
    isDeepStrictEqual(uncommented(old), uncommented(current));
  return {
    added,
    removed,
    redefined: kept.filter((pair) => !same(pair)),
    recommented: kept.filter((pair) => same(pair)),
  };
}
