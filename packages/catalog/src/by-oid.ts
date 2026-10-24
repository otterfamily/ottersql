import type { PGlite } from "@electric-sql/pglite";

import type { TypeRef } from "./model.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

/** A table, view or other relation, with the names of its columns by attribute number. */
export interface Relation {
  readonly schema: string;
  readonly name: string;
  readonly columns: ReadonlyMap<number, string>;
}

/** The type references for type oids, such as those Postgres reports for query parameters. */
export async function readTypeRefs(
  db: PGlite,
  oids: readonly number[],
): Promise<ReadonlyMap<number, TypeRef>> {
  const { rows } = await db.query<{ readonly oid: number; readonly type: TypeRow }>(
    `select t.oid::int as oid, ${typeRefJson("t.oid")} as type from pg_type t where t.oid = any($1::oid[])`,
    [oids],
  );
  return new Map(rows.map((row) => [row.oid, parseTypeRef(row.type)]));
}

/** The relations for relation oids, such as those Postgres reports as a result column's origin. */
export async function readRelations(
  db: PGlite,
  oids: readonly number[],
): Promise<ReadonlyMap<number, Relation>> {
  const { rows } = await db.query<{
    readonly oid: number;
    readonly schema: string;
    readonly name: string;
    readonly columns: readonly (readonly [number, string])[];
  }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name,
       coalesce((
         select json_agg(json_build_array(a.attnum, a.attname) order by a.attnum)
         from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       ), '[]') as columns
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.oid = any($1::oid[])`,
    [oids],
  );
  return new Map(
    rows.map((row) => [
      row.oid,
      { schema: row.schema, name: row.name, columns: new Map(row.columns) },
    ]),
  );
}
