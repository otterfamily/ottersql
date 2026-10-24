import type { Catalog } from "@ottersql/catalog";

import { enumChanges } from "./enums.ts";
import type { Plan, Step } from "./plan.ts";
import { combine } from "./steps.ts";
import { tableChanges } from "./tables.ts";
import { unplannedChanges } from "./unplanned-objects.ts";

/**
 * The order steps run in: everything before the deploy, then everything after. Types come before
 * the tables that use them, relaxed rules before the app that relies on them, and new constraints
 * are added before the columns and tables they no longer need are dropped. A key goes before the
 * NOT NULL its columns need, and a foreign key before the key and the table it references.
 */
const stepOrder: readonly `${Step["phase"]} ${Step["kind"]}`[] = [
  "expand createEnum",
  "expand addEnumValue",
  "expand createTable",
  "expand addColumn",
  "expand setDefault",
  "expand dropForeignKey",
  "expand dropConstraint",
  "expand dropNotNull",
  "expand addCheck",
  "expand addForeignKey",
  "expand createIndex",
  "expand comment",
  "contract dropIndex",
  "contract createIndex",
  "contract addCheck",
  "contract validateCheck",
  "contract setNotNull",
  "contract addUnique",
  "contract addPrimaryKey",
  "contract addForeignKey",
  "contract validateForeignKey",
  "contract dropDefault",
  "contract dropColumn",
  "contract dropForeignKey",
  "contract dropTable",
  "contract dropEnum",
];

function rank(step: Step): number {
  return stepOrder.indexOf(`${step.phase} ${step.kind}`);
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
