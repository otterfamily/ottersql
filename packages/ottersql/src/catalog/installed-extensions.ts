import type { Transaction } from "../sql/index.ts";
import { fields, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { scopeParameters, userObject } from "./scope.ts";

/**
 * An extension installed in the database, by the schema it was installed into. Its version is left
 * out: PGlite and a server can ship different versions of the same extension.
 */
export interface InstalledExtension {
  readonly schema: string;
  readonly name: string;
}

const extensionRow: Shape<InstalledExtension> = (value, path) => {
  const field = fields(value, path);
  return { schema: field("schema", string), name: field("name", string) };
};

/** The extensions installed in user schemas; those in pg_catalog, such as plpgsql, come with Postgres. */
export async function readExtensions(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<readonly InstalledExtension[]> {
  return queryRows(transaction, {
    select: `select n.nspname as schema, e.extname as name
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where ${userObject("pg_extension", "e.oid", "e.extnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: extensionRow,
    label: "extensions",
    parameters: scopeParameters(omitSchemas),
  });
}
