import { fields, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import type { Policy, RowSecurity } from "./model/table.ts";

export const policyRow: Shape<Policy> = (value, path) => {
  const field = fields(value, path);
  return { name: field("name", string), definition: field("definition", string) };
};

/** The row security of the pg_class row `c`, as `parseRowSecurity` reads it. */
export function rowSecurityJson(): string {
  return "case when c.relforcerowsecurity then 'f' when c.relrowsecurity then 'e' else 'd' end";
}

const rowSecurities = { d: "disabled", e: "enabled", f: "forced" } as const;

export function parseRowSecurity(code: string): RowSecurity {
  return decode(rowSecurities, code, "pg_class.relrowsecurity");
}

/** Selects the policies of the table `relationOid`, in name order, as `policyRow` reads them. */
export function policiesJson(relationOid: string): string {
  return `coalesce((
    select json_agg(json_build_object(
      'name', pol.polname,
      'definition', concat_ws(' ',
        case when pol.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
        'FOR', case pol.polcmd
          when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
          when 'd' then 'DELETE' else 'ALL' end,
        'TO', (
          select string_agg(
            case when role_oid = 0 then 'public' else quote_ident(pg_get_userbyid(role_oid)) end,
            ', ' order by role_oid)
          from unnest(pol.polroles) as role_oid
        ),
        'USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')',
        'WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')'
      )
    ) order by pol.polname)
    from pg_policy pol
    where pol.polrelid = ${relationOid}
  ), '[]')`;
}
