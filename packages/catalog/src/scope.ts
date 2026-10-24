/**
 * SQL condition that keeps a `pg_class` row (aliased `alias`) only if the user's schema defines it:
 * system schemas and objects that belong to an extension are left out.
 */
export function userRelation(alias: string): string {
  return `${userNamespace(`${alias}.relnamespace`)} and ${notExtensionMember("pg_class", `${alias}.oid`)}`;
}

function userNamespace(namespaceOid: string): string {
  return `${namespaceOid} not in (select oid from pg_namespace where nspname in ('pg_catalog', 'information_schema', 'pg_toast') or nspname like 'pg\\_temp\\_%' or nspname like 'pg\\_toast\\_temp\\_%')`;
}

function notExtensionMember(catalogTable: string, objectOid: string): string {
  return `not exists (select from pg_depend d where d.classid = '${catalogTable}'::regclass and d.objid = ${objectOid} and d.deptype = 'e')`;
}
