import type { PGlite } from "@electric-sql/pglite";
import type { Column, Table } from "./model.ts";
import { userRelation } from "./scope.ts";
import { parseTypeRef, typeRefJson, type TypeRow } from "./type-ref.ts";

interface TableRow {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnRow[];
}

interface ColumnRow {
  readonly name: string;
  readonly type: TypeRow;
  readonly typeSql: string;
  readonly notNull: boolean;
}

export async function readTables(db: PGlite): Promise<Table[]> {
  const { rows } = await db.query<TableRow>(`
    select n.nspname as schema, c.relname as name,
      coalesce((
        select json_agg(json_build_object(
          'name', a.attname,
          'type', ${typeRefJson("a.atttypid")},
          'typeSql', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull
        ) order by a.attnum)
        from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]') as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and ${userRelation("c")}
    order by n.nspname, c.relname
  `);
  return rows.map(parseTable);
}

function parseTable(row: TableRow): Table {
  return { schema: row.schema, name: row.name, columns: row.columns.map(parseColumn) };
}

function parseColumn(row: ColumnRow): Column {
  return {
    name: row.name,
    type: parseTypeRef(row.type),
    typeSql: row.typeSql,
    notNull: row.notNull,
  };
}
