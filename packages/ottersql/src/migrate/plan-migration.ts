import type { Catalog } from "../catalog/index.ts";
import { combine } from "./changes.ts";
import { compositeChanges } from "./composites.ts";
import { enumChanges } from "./enums.ts";
import { phases } from "./plan.ts";
import type { Plan, Step } from "./plan.ts";
import { schemaChanges } from "./schemas.ts";
import { hierarchyChanges } from "./table-hierarchies.ts";
import { tableChanges } from "./tables.ts";
import { triggerAndPolicyChanges } from "./triggers-and-policies.ts";
import { unplannedAdditions, unplannedChanges } from "./unplanned-objects.ts";

/**
 * The order steps run in: everything before the deploy, then everything after, and within each,
 * by kind. Types come before the tables that use them, relaxed rules before the app that relies on
 * them, and new constraints are added before the columns and tables they no longer need are
 * dropped. A key goes before the NOT NULL its columns need, a foreign key before the key and the
 * table it references, and a rebuilt index is built before the old one is dropped. A schema comes
 * before everything in it and goes after.
 */
const kindOrder: Readonly<Record<Step["kind"], number>> = {
  createSchema: 0,
  createEnum: 1,
  addEnumValue: 2,
  createType: 3,
  createTable: 4,
  addColumn: 5,
  widenColumn: 6,
  setDefault: 7,
  dropForeignKey: 8,
  dropConstraint: 9,
  dropNotNull: 10,
  createIndex: 11,
  dropIndex: 12,
  renameIndex: 13,
  addCheck: 14,
  validateCheck: 15,
  setNotNull: 16,
  addUnique: 17,
  addPrimaryKey: 18,
  addForeignKey: 19,
  validateForeignKey: 20,
  replaceConstraint: 21,
  comment: 22,
  dropDefault: 23,
  dropColumn: 24,
  dropTable: 25,
  dropEnum: 26,
  dropSchema: 27,
  custom: 28,
};

function rank(step: Step): number {
  return phases.indexOf(step.phase) * Object.keys(kindOrder).length + kindOrder[step.kind];
}

/**
 * Plans the forward-only migration from the schema `from` describes to the one `to` describes
 * (ADR 0004). Differences the planner cannot turn into safe steps are listed in `manual`, with why.
 */
export function planMigration(from: Catalog, to: Catalog): Plan {
  const unplanned = unplannedAdditions(from, to);
  const { steps, manual } = combine([
    schemaChanges(from, to),
    enumChanges(from, to),
    compositeChanges(from, to, unplanned),
    tableChanges({ from, to, unplanned }),
    triggerAndPolicyChanges(from, to),
    hierarchyChanges(from, to),
    unplannedChanges(from, to),
  ]);
  return { steps: steps.toSorted((left, right) => rank(left) - rank(right)), manual };
}
