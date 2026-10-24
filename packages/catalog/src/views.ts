import type { PGlite } from "@electric-sql/pglite";

import { columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import { parseComment } from "./comments.ts";
import type { View } from "./model.ts";
import { userObject } from "./scope.ts";

interface ViewRow {
  readonly schema: string;
  readonly name: string;
  readonly materialized: boolean;
  readonly columns: readonly ColumnBaseRow[];
  readonly comment: string | null;
}

export async function readViews(db: PGlite): Promise<View[]> {
  const { rows } = await db.query<ViewRow>(`
    select n.nspname as schema, c.relname as name, c.relkind = 'm' as materialized,
      ${columnsJson("c.oid")} as columns,
      obj_description(c.oid, 'pg_class') as comment
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and ${userObject("pg_class", "c.oid", "c.relnamespace")}
    order by n.nspname, c.relname
  `);
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    materialized: row.materialized,
    columns: row.columns.map((column) => parseColumnBase(column)),
    comment: parseComment(row.comment),
  }));
}
