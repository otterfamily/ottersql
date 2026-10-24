import type { Catalog } from "@ottersql/catalog";

import { enumChanges } from "./enums.ts";
import { phases } from "./plan.ts";
import type { Plan, Step } from "./plan.ts";
import { combine } from "./steps.ts";
import { tableChanges } from "./tables.ts";
import { unplannedChanges } from "./unplanned-objects.ts";

/**
 * The order steps run in: everything before the deploy, then everything after, and within each,
 * by kind. Types come before the tables that use them, relaxed rules before the app that relies on
 * them, and new constraints are added before the columns and tables they no longer need are
 * dropped. A key goes before the NOT NULL its columns need, a foreign key before the key and the
 * table it references, and a rebuilt index is built before the old one is dropped.
 */
const kindOrder: Readonly<Record<Step["kind"], number>> = {
  createEnum: 0,
  addEnumValue: 1,
  createTable: 2,
  addColumn: 3,
  setDefault: 4,
  dropForeignKey: 5,
  dropConstraint: 6,
  dropNotNull: 7,
  createIndex: 8,
  dropIndex: 9,
  renameIndex: 10,
  addCheck: 11,
  validateCheck: 12,
  setNotNull: 13,
  addUnique: 14,
  addPrimaryKey: 15,
  addForeignKey: 16,
  validateForeignKey: 17,
  comment: 18,
  dropDefault: 19,
  dropColumn: 20,
  dropTable: 21,
  dropEnum: 22,
  custom: 23,
};

function rank(step: Step): number {
  return phases.indexOf(step.phase) * Object.keys(kindOrder).length + kindOrder[step.kind];
}

/**
 * Plans the forward-only migration from the schema `from` describes to the one `to` describes
 * (ADR 0004). Differences the planner cannot turn into safe steps are listed in `manual`, with why.
 */
export function planMigration(from: Catalog, to: Catalog): Plan {
  const { steps, manual } = combine([
    enumChanges(from, to),
    tableChanges(from, to),
    unplannedChanges(from, to),
  ]);
  return { steps: steps.toSorted((left, right) => rank(left) - rank(right)), manual };
}
