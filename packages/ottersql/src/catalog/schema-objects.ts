import type { CatalogReads } from "./catalog-json.ts";
import type { CatalogFeatures } from "./features.ts";
import { extensionsRead } from "./installed-extensions.ts";
import type { Catalog } from "./model.ts";
import { routinesRead } from "./routines.ts";
import { sequencesRead } from "./sequences.ts";
import {
  collationsRead,
  textSearchConfigurationsRead,
  textSearchDictionariesRead,
} from "./text-settings.ts";
import { userTypeReads } from "./user-types.ts";
import { viewsRead } from "./views.ts";

/**
 * What the user's schemas hold besides tables: extensions, sequences, types, collations, text
 * search settings, views and routines.
 */
export function schemaObjectReads(
  features: CatalogFeatures,
): CatalogReads<Omit<Catalog, "capabilities" | "schemas" | "tables">> {
  const userTypes = userTypeReads(features);
  return {
    reads: [
      extensionsRead,
      sequencesRead,
      ...userTypes.reads,
      collationsRead,
      textSearchConfigurationsRead,
      textSearchDictionariesRead,
      viewsRead,
      routinesRead,
    ],
    make: (results) => ({
      extensions: results(extensionsRead),
      sequences: results(sequencesRead),
      ...userTypes.make(results),
      collations: results(collationsRead),
      textSearchConfigurations: results(textSearchConfigurationsRead),
      textSearchDictionaries: results(textSearchDictionariesRead),
      views: results(viewsRead),
      routines: results(routinesRead),
    }),
  };
}
