import type { Connection } from "@ottersql/sql";

import { boolean, fields, queryRows } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";

/**
 * Catalog columns that only some supported majors have. Queries are built from these rather than
 * from the version number (ADR 0010), so a host that reports a version still reads correctly.
 */
export interface CatalogFeatures {
  /** `pg_constraint.conenforced` (Postgres 18): constraints can be NOT ENFORCED. */
  readonly enforcedFlag: boolean;
}

const featuresRow: Shape<CatalogFeatures> = (value, path) => {
  const field = fields(value, path);
  return { enforcedFlag: field("enforcedFlag", boolean) };
};

export async function readFeatures(connection: Connection): Promise<CatalogFeatures> {
  const [features] = await queryRows(connection, {
    select: `select exists (
        select from pg_attribute
        where attrelid = 'pg_catalog.pg_constraint'::regclass and attname = 'conenforced'
      ) as "enforcedFlag"`,
    row: featuresRow,
    label: "features",
  });
  if (features === undefined) {
    throw new Error("the features query returned no row");
  }
  return features;
}
