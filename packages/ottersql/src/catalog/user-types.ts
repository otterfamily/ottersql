import type { CatalogReads } from "./catalog-json.ts";
import { compositesRead } from "./composites.ts";
import { domainsRead } from "./domains.ts";
import { enumsRead } from "./enums.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Catalog } from "./model/catalog.ts";
import { rangesRead } from "./ranges.ts";

/** The types the user's schemas define: enums, composite types, range types and domains. */
export function userTypeReads(
  features: CatalogFeatures,
): CatalogReads<Pick<Catalog, "enums" | "composites" | "ranges" | "domains">> {
  const domains = domainsRead(features);
  return {
    reads: [enumsRead, compositesRead, rangesRead, domains],
    make: (results) => ({
      enums: results(enumsRead),
      composites: results(compositesRead),
      ranges: results(rangesRead),
      domains: results(domains),
    }),
  };
}
