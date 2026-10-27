import { catalogRead, fields, string } from "./catalog-json.ts";
import type { CatalogRead, Shape } from "./catalog-json.ts";
import type { InstalledExtension } from "./model/catalog.ts";
import { userObject } from "./scope.ts";

const extensionRow: Shape<InstalledExtension> = (value, path) => {
  const field = fields(value, path);
  return { schema: field("schema", string), name: field("name", string) };
};

/** The extensions installed in user schemas; those in pg_catalog, such as plpgsql, come with Postgres. */
export const extensionsRead: CatalogRead<readonly InstalledExtension[]> = catalogRead(
  {
    select: `select n.nspname as schema, e.extname as name
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where ${userObject("pg_extension", "e.oid", "e.extnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: extensionRow,
    label: "extensions",
  },
  (rows) => rows,
);
