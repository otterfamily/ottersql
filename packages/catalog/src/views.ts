import type { PGlite } from "@electric-sql/pglite";

import { parseComment } from "./comments.ts";
import type { View, ViewColumn } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface ViewRow {
  readonly schema: string;
  readonly name: string;
  readonly materialized: boolean;
  readonly columns: readonly ViewColumnRow[];
  readonly comment: string | null;
}

interface ViewColumnRow {
  readonly name: string;
  readonly type: TypeRow;
  readonly typeSql: string;
  readonly comment: string | null;
}

export async function readViews(db: PGlite): Promise<View[]> {
  const { rows } = await db.query<ViewRow>(`
    select n.nspname as schema, c.relname as name, c.relkind = 'm' as materialized,
      coalesce((
        select json_agg(json_build_object(
          'name', a.attname,
          'type', ${typeRefJson("a.atttypid")},
          'typeSql', format_type(a.atttypid, a.atttypmod),
          'comment', col_description(a.attrelid, a.attnum)
        ) order by a.attnum)
        from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]') as columns,
      obj_description(c.oid, 'pg_class') as comment
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and ${userObject("pg_class", "c.oid", "c.relnamespace")}
    order by n.nspname, c.relname
  `);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    materialized: row.materialized,
    columns: row.columns.map((column) => parseViewColumn(column)),
    comment: parseComment(row.comment),
  }));
}

function parseViewColumn(row: ViewColumnRow): ViewColumn {
  return {
    name: row.name,
    type: parseTypeRef(row.type),
    typeSql: row.typeSql,
    comment: parseComment(row.comment),
  };
}
