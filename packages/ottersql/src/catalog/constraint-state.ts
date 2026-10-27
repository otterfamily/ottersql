import { boolean } from "./catalog-json.ts";
import type { Field } from "./catalog-json.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Deferral, Enforcement } from "./model/shared.ts";

/**
 * Selects the fields `parseDeferral` and `parseEnforcement` read from the `pg_constraint` row
 * `alias`. Before Postgres 18 every constraint is enforced.
 */
export function constraintStateFields(alias: string, features: CatalogFeatures): string {
  const enforced = features.enforcedFlag ? `${alias}.conenforced` : "true";
  return `'deferrable', ${alias}.condeferrable, 'deferred', ${alias}.condeferred,
    'validated', ${alias}.convalidated, 'enforced', ${enforced}`;
}

export interface ConstraintStateRow {
  readonly deferrable: boolean;
  readonly deferred: boolean;
  readonly validated: boolean;
  readonly enforced: boolean;
}

export function constraintState(field: Field): ConstraintStateRow {
  return {
    deferrable: field("deferrable", boolean),
    deferred: field("deferred", boolean),
    validated: field("validated", boolean),
    enforced: field("enforced", boolean),
  };
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
