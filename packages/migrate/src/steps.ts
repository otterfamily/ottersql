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

export function only(...steps: readonly Step[]): Changes {
  return { steps, manual: [] };
}

/** Objects keyed by name that `from` and `to` both have, only one of them has, or neither. */
export function matchByName<Item extends { readonly name: string }>(
  from: readonly Item[],
  to: readonly Item[],
): {
  readonly added: readonly Item[];
  readonly removed: readonly Item[];
  readonly kept: readonly (readonly [Item, Item])[];
} {
  const fromByName = new Map(from.map((item) => [item.name, item]));
  const toNames = new Set(to.map((item) => item.name));
  return {
    added: to.filter((item) => !fromByName.has(item.name)),
    removed: from.filter((item) => !toNames.has(item.name)),
    kept: to.flatMap((item) => {
      const before = fromByName.get(item.name);
      return before === undefined ? [] : [[before, item] as const];
    }),
  };
}
