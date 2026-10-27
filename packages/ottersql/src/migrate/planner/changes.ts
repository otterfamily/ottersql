import type { QualifiedName } from "../../catalog/index.ts";
import type { InsideStep, ManualChange, OutsideStep, Step } from "../plan.ts";

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

// Postgres folds a bare name to lower case, so only these read back as themselves unquoted.
const bareName = /^[_a-z][$0-9_a-z]*$/v;

function shownName(name: string): string {
  return bareName.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * `schema`, `schema.name` or `schema.table.member`, as plans name what a step changes. A part is
 * quoted as SQL quotes it when Postgres would read it bare as another name, such as `"Users"` or
 * `"user.archive"`.
 */
export function objectName(object: QualifiedName | string, member?: string): string {
  const parts = typeof object === "string" ? [object] : [object.schema, object.name];
  return [...parts, ...(member === undefined ? [] : [member])]
    .map((part) => shownName(part))
    .join(".");
}
