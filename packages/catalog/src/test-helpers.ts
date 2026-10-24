import type { Catalog, Table } from "./index.ts";

export function table(catalog: Catalog, name: string, schema = "public"): Table {
  const found = catalog.tables.find(
    (candidate) => candidate.schema === schema && candidate.name === name,
  );
  if (found === undefined) {
    throw new Error(`table ${schema}.${name} not in catalog`);
  }
  return found;
}
