import { createHash } from "node:crypto";

import type { StepRef } from "./apply-migrations.ts";
import type { PendingStep } from "./ledger.ts";
import type { Step } from "./plan.ts";

/** A pending step that cannot be undone, such as dropping a column. */
export interface IrreversibleStep extends StepRef {
  readonly kind: Step["kind"];
  readonly object: string;
}

/**
 * Pending steps cannot be undone and `approve` was not given for them, so nothing ran. `approval`
 * names the pending steps as they are now; it stops matching when they change.
 */
export class ApprovalRequiredError extends Error {
  override readonly name = "ApprovalRequiredError";
  readonly approval: string;
  readonly steps: readonly IrreversibleStep[];

  constructor(approval: string, steps: readonly IrreversibleStep[]) {
    super(
      `${String(steps.length)} pending steps cannot be undone; review them and apply again with their approval`,
    );
    this.approval = approval;
    this.steps = steps;
  }
}

/** Throws an `ApprovalRequiredError` unless `pending` can all be undone or `approve` covers it. */
export function checkApproval(pending: readonly PendingStep[], approve: string | undefined): void {
  const irreversible = pending.filter(({ step }) => step.reversal === "irreversible");
  if (irreversible.length === 0) {
    return;
  }
  const approval = createHash("sha256")
    .update(JSON.stringify(pending.map(({ migration, index, hash }) => [migration, index, hash])))
    .digest("hex");
  if (approve !== approval) {
    throw new ApprovalRequiredError(
      approval,
      irreversible.map(({ migration, index, step }) => ({
        migration,
        step: index,
        kind: step.kind,
        object: step.object,
      })),
    );
  }
}
