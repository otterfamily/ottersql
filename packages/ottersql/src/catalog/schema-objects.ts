import type { Transaction } from "../sql/index.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import type { CatalogFeatures } from "./features.ts";
import { readExtensions } from "./installed-extensions.ts";
import type { Catalog } from "./model.ts";
import { readRanges } from "./ranges.ts";
import { readRoutines } from "./routines.ts";
import { readSequences } from "./sequences.ts";
import { readViews } from "./views.ts";

/** What the user's schemas hold besides tables: extensions, sequences, types, views and routines. */
export async function readSchemaObjects(
  transaction: Transaction,
  features: CatalogFeatures,
  omitSchemas: readonly string[],
): Promise<Omit<Catalog, "capabilities" | "schemas" | "tables">> {
  return {
    extensions: await readExtensions(transaction, omitSchemas),
    sequences: await readSequences(transaction, omitSchemas),
    enums: await readEnums(transaction, omitSchemas),
    ranges: await readRanges(transaction, omitSchemas),
    domains: await readDomains(transaction, features, omitSchemas),
    views: await readViews(transaction, omitSchemas),
    routines: await readRoutines(transaction, omitSchemas),
  };
}
