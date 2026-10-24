import type { PGlite } from "@electric-sql/pglite";

import type { Enum } from "./model.ts";
import { userObject } from "./scope.ts";

export async function readEnums(db: PGlite): Promise<Enum[]> {
  const { rows } = await db.query<Enum>(`
    select n.nspname as schema, t.typname as name,
      array(select e.enumlabel from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder)
        as values
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and ${userObject("pg_type", "t.oid", "t.typnamespace")}
    order by n.nspname, t.typname
  `);
  return rows;
}
