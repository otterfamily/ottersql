import type { Transaction } from "../sql/index.ts";
import { readComposites } from "./composites.ts";
import { readDomains } from "./domains.ts";
import { readEnums } from "./enums.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Catalog } from "./model.ts";
import { readRanges } from "./ranges.ts";

/** The types the user's schemas define: enums, composite types, range types and domains. */
export async function readUserTypes(
  transaction: Transaction,
  features: CatalogFeatures,
  omitSchemas: readonly string[],
): Promise<Pick<Catalog, "enums" | "composites" | "ranges" | "domains">> {
  return {
    enums: await readEnums(transaction, omitSchemas),
    composites: await readComposites(transaction, omitSchemas),
    ranges: await readRanges(transaction, omitSchemas),
    domains: await readDomains(transaction, features, omitSchemas),
  };
}
