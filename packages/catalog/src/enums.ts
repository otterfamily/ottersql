import type { PGlite } from "@electric-sql/pglite";

import { parseComment } from "./comments.ts";
import type { Enum } from "./model.ts";
import { userObject } from "./scope.ts";

export async function readEnums(db: PGlite): Promise<Enum[]> {
  const { rows } = await db.query<EnumRow>(`
    select n.nspname as schema, t.typname as name,
      array(select e.enumlabel from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder)
        as values,
      obj_description(t.oid, 'pg_type') as comment
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and ${userObject("pg_type", "t.oid", "t.typnamespace")}
    order by n.nspname, t.typname
  `);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    values: row.values,
    comment: parseComment(row.comment),
  }));
}

interface EnumRow {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly comment: string | null;
}
