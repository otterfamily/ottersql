/** The parameters of a catalog query that keeps rows with `userObject`. */
export function scopeParameters(omitSchemas: readonly string[]): string[] {
  return [JSON.stringify(omitSchemas)];
}

/**
 * SQL condition that keeps a row of `catalogTable` only if the user's schema defines it: system
 * schemas, the schemas named by the JSON array in parameter $1 (from `scopeParameters`) and objects
 * that belong to an extension are left out.
 */
export function userObject(
  catalogTable: "pg_class" | "pg_proc" | "pg_type",
  objectOid: string,
  namespaceOid: string,
): string {
  return `${namespaceOid} not in (
      select oid from pg_namespace
      where nspname in ('pg_catalog', 'information_schema', 'pg_toast')
        or nspname in (select json_array_elements_text($1::json))
        or nspname like 'pg\\_temp\\_%' or nspname like 'pg\\_toast\\_temp\\_%'
    )
    and not exists (
      select from pg_depend d
      where d.classid = '${catalogTable}'::regclass and d.objid = ${objectOid} and d.deptype = 'e'
    )`;
}
