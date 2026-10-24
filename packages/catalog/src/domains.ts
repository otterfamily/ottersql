import type { PGlite } from "@electric-sql/pglite";

import { allowedValues } from "./checks.ts";
import { parseComment } from "./comments.ts";
import { parseEnforcement } from "./constraints.ts";
import type { Domain, DomainCheck } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface DomainRow {
  readonly schema: string;
  readonly name: string;
  readonly baseType: TypeRow;
  readonly baseTypeSql: string;
  readonly notNull: boolean;
  readonly default: string | null;
  readonly checks: readonly DomainCheckRow[];
  readonly comment: string | null;
}

interface DomainCheckRow {
  readonly name: string;
  readonly expression: string;
  readonly validated: boolean;
  readonly enforced: boolean;
}

export async function readDomains(db: PGlite): Promise<Domain[]> {
  const { rows } = await db.query<DomainRow>(`
    select n.nspname as schema, t.typname as name,
      ${typeRefJson("t.typbasetype")} as "baseType",
      format_type(t.typbasetype, t.typtypmod) as "baseTypeSql",
      t.typnotnull as "notNull",
      t.typdefault as default,
      obj_description(t.oid, 'pg_type') as comment,
      coalesce((
        select json_agg(json_build_object(
          'name', con.conname,
          'expression', pg_get_expr(con.conbin, 0),
          'validated', con.convalidated,
          'enforced', con.conenforced
        ) order by con.conname)
        from pg_constraint con
        where con.contypid = t.oid and con.contype = 'c'
      ), '[]') as checks
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'd' and ${userObject("pg_type", "t.oid", "t.typnamespace")}
    order by n.nspname, t.typname
  `);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    baseType: parseTypeRef(row.baseType),
    baseTypeSql: row.baseTypeSql,
    notNull: row.notNull,
    default: row.default,
    checks: row.checks.map((check) => parseDomainCheck(check)),
    comment: parseComment(row.comment),
  }));
}

function parseDomainCheck(row: DomainCheckRow): DomainCheck {
  return {
    name: row.name,
    expression: row.expression,
    allowedValues: allowedValues(row.expression, "VALUE"),
    enforcement: parseEnforcement(row),
  };
}
