import type { Deferral, Enforcement } from "./model.ts";

/** Selects the fields `parseDeferral` and `parseEnforcement` read from the `pg_constraint` row `alias`. */
export function constraintStateFields(alias: string): string {
  return `'deferrable', ${alias}.condeferrable, 'deferred', ${alias}.condeferred,
    'validated', ${alias}.convalidated, 'enforced', ${alias}.conenforced`;
}

export interface ConstraintStateRow {
  readonly deferrable: boolean;
  readonly deferred: boolean;
  readonly validated: boolean;
  readonly enforced: boolean;
}

export function parseDeferral(row: ConstraintStateRow): Deferral {
  if (!row.deferrable) {
    return "not deferrable";
  }
  return row.deferred ? "initially deferred" : "initially immediate";
}

export function parseEnforcement(row: ConstraintStateRow): Enforcement {
  if (!row.enforced) {
    return "not enforced";
  }
  return row.validated ? "validated" : "not valid";
}
