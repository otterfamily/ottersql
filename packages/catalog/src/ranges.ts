import type { PGlite } from "@electric-sql/pglite";

import { parseComment } from "./comments.ts";
import type { RangeType } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface RangeRow {
  readonly schema: string;
  readonly name: string;
  readonly multirange: string;
  readonly subtype: TypeRow;
  readonly comment: string | null;
}

export async function readRanges(db: PGlite): Promise<RangeType[]> {
  const { rows } = await db.query<RangeRow>(`
    select n.nspname as schema, t.typname as name, m.typname as multirange,
      ${typeRefJson("r.rngsubtype")} as subtype,
      obj_description(t.oid, 'pg_type') as comment
    from pg_range r
      join pg_type t on t.oid = r.rngtypid
      join pg_namespace n on n.oid = t.typnamespace
      join pg_type m on m.oid = r.rngmultitypid
    where ${userObject("pg_type", "t.oid", "t.typnamespace")}
    order by n.nspname, t.typname
  `);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    multirange: row.multirange,
    subtype: parseTypeRef(row.subtype),
    comment: parseComment(row.comment),
  }));
}
