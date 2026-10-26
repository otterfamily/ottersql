import type { Catalog } from "../catalog/index.ts";
import { enumChanges } from "./enums.ts";
import { partitionChanges } from "./partitions.ts";
import { phases } from "./plan.ts";
import type { Plan, Step } from "./plan.ts";
import { schemaChanges } from "./schemas.ts";
import { combine } from "./steps.ts";
import { tableRuleChanges } from "./table-rules.ts";
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
  widenColumn: 5,
  setDefault: 6,
  dropForeignKey: 7,
  dropConstraint: 8,
  dropNotNull: 9,
  createIndex: 10,
  dropIndex: 11,
  renameIndex: 12,
  addCheck: 13,
  validateCheck: 14,
  setNotNull: 15,
  addUnique: 16,
  addPrimaryKey: 17,
  addForeignKey: 18,
  validateForeignKey: 19,
  replaceConstraint: 20,
  comment: 21,
  dropDefault: 22,
  dropColumn: 23,
  dropTable: 24,
  dropEnum: 25,
  dropSchema: 26,
  custom: 27,
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
    tableRuleChanges(from, to),
    partitionChanges(from, to),
    unplannedChanges(from, to),
  ]);
  return { steps: steps.toSorted((left, right) => rank(left) - rank(right)), manual };
}
