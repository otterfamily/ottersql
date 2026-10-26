import type { Catalog } from "../catalog/index.ts";
import { enumChanges } from "./enums.ts";
import { phases } from "./plan.ts";
import type { Plan, Step } from "./plan.ts";
import { schemaChanges } from "./schemas.ts";
import { combine } from "./steps.ts";
import { tableChanges } from "./tables.ts";
import { unplannedChanges } from "./unplanned-objects.ts";

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
  createTable: 3,
  addColumn: 4,
  setDefault: 5,
  dropForeignKey: 6,
  dropConstraint: 7,
  dropNotNull: 8,
  createIndex: 9,
  dropIndex: 10,
  renameIndex: 11,
  addCheck: 12,
  validateCheck: 13,
  setNotNull: 14,
  addUnique: 15,
  addPrimaryKey: 16,
  addForeignKey: 17,
  validateForeignKey: 18,
  comment: 19,
  dropDefault: 20,
  dropColumn: 21,
  dropTable: 22,
  dropEnum: 23,
  dropSchema: 24,
  custom: 25,
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
    schemaChanges(from, to),
    enumChanges(from, to),
    tableChanges(from, to),
    unplannedChanges(from, to),
  ]);
  return { steps: steps.toSorted((left, right) => rank(left) - rank(right)), manual };
}
