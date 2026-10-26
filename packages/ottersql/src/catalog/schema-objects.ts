import type { Transaction } from "../sql/index.ts";
import type { CatalogFeatures } from "./features.ts";
import { readExtensions } from "./installed-extensions.ts";
import type { Catalog } from "./model.ts";
import { readRoutines } from "./routines.ts";
import { readSequences } from "./sequences.ts";
import { readTextSettings } from "./text-settings.ts";
import { readUserTypes } from "./user-types.ts";
import { readViews } from "./views.ts";

/**
 * What the user's schemas hold besides tables: extensions, sequences, types, collations, text
 * search settings, views and routines.
 */
export async function readSchemaObjects(
  transaction: Transaction,
  features: CatalogFeatures,
  omitSchemas: readonly string[],
): Promise<Omit<Catalog, "capabilities" | "schemas" | "tables">> {
  return {
    extensions: await readExtensions(transaction, omitSchemas),
    sequences: await readSequences(transaction, omitSchemas),
    ...(await readUserTypes(transaction, features, omitSchemas)),
    ...(await readTextSettings(transaction, omitSchemas)),
    views: await readViews(transaction, omitSchemas),
    routines: await readRoutines(transaction, omitSchemas),
  };
}
