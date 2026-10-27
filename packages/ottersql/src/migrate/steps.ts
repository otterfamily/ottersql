import { nameKey } from "../catalog/find.ts";
import type { QualifiedName } from "../catalog/index.ts";
import type { InsideStep, ManualChange, OutsideStep, Step } from "./plan.ts";

/** A step that runs in a transaction and needs no explanation unless told otherwise. */
export function step(
  spec: Omit<InsideStep, "transaction" | "reason"> & Partial<Pick<InsideStep, "reason">>,
): InsideStep {
  return { transaction: "inside", reason: null, ...spec };
}

/** A step that cannot run in a transaction, building or dropping an index concurrently. */
export function outsideStep(
  spec: Omit<OutsideStep, "transaction" | "reason"> & Partial<Pick<OutsideStep, "reason">>,
): OutsideStep {
  return { transaction: "outside", reason: null, ...spec };
}

/** What one part of the planner found: steps in any order, and changes left to a person. */
export interface Changes {
  readonly steps: readonly Step[];
  readonly manual: readonly ManualChange[];
}

export const noChanges: Changes = { steps: [], manual: [] };

export function combine(changes: readonly Changes[]): Changes {
  return {
    steps: changes.flatMap((change) => change.steps),
    manual: changes.flatMap((change) => change.manual),
  };
}

export function manual(object: string, reason: string): Changes {
  return { steps: [], manual: [{ object, reason }] };
}

/** Why a change to `what`, such as "a trigger", is left to a person. */
export function notPlanned(what: string): string {
  return `ottersql does not plan changes to ${what} yet; write this change by hand`;
}

export function only(...steps: readonly Step[]): Changes {
  return { steps, manual: [] };
}

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

/** `schema.name`, or `schema.table.member`, as plans name what a step changes. */
export function objectName(object: QualifiedName, member?: string): string {
  return member === undefined
    ? `${object.schema}.${object.name}`
    : `${object.schema}.${object.name}.${member}`;
}
