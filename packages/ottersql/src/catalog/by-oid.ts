import type { Connection } from "../sql/index.ts";
import { array, fields, number, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import type { TypeRef } from "./model.ts";
import { parseTypeRef, typeRefJson, typeRow } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

/** A table, view or other relation, with the names of its columns by attribute number. */
export interface Relation {
  readonly schema: string;
  readonly name: string;
  readonly columns: ReadonlyMap<number, string>;
}

/** `oids` as the text of a Postgres `oid[]` parameter. */
function oidArray(oids: readonly number[]): string {
  return `{${oids.map(String).join(",")}}`;
}

const attribute = (value: unknown, path: string): readonly [number, string] => {
  const field = fields(value, path);
  return [field("attnum", number), field("name", string)];
};

const typeRefRow: Shape<{ readonly oid: number; readonly type: TypeRow }> = (value, path) => {
  const field = fields(value, path);
  return { oid: field("oid", number), type: field("type", typeRow) };
};

const relationRow: Shape<Relation & { readonly oid: number }> = (value, path) => {
  const field = fields(value, path);
  return {
    oid: field("oid", number),
    schema: field("schema", string),
    name: field("name", string),
    columns: new Map(field("columns", array(attribute))),
  };
};

/** The type references for type oids, such as those Postgres reports for query parameters. */
export async function readTypeRefs(
  connection: Connection,
  oids: readonly number[],
): Promise<ReadonlyMap<number, TypeRef>> {
  const rows = await queryRows(connection, {
    select: `select t.oid::int as oid, ${typeRefJson("t.oid")} as type
        from pg_type t where t.oid = any($1::oid[])`,
    parameters: [oidArray(oids)],
    row: typeRefRow,
    label: "types",
  });
  return new Map(rows.map((row) => [row.oid, parseTypeRef(row.type)]));
}

/** The relations for relation oids, such as those Postgres reports as a result column's origin. */
export async function readRelations(
  connection: Connection,
  oids: readonly number[],
): Promise<ReadonlyMap<number, Relation>> {
  const rows = await queryRows(connection, {
    select: `select c.oid::int as oid, n.nspname as schema, c.relname as name,
         coalesce((
           select json_agg(json_build_object('attnum', a.attnum, 'name', a.attname) order by a.attnum)
           from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         ), '[]') as columns
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.oid = any($1::oid[])`,
    parameters: [oidArray(oids)],
    row: relationRow,
    label: "relations",
  });
  return new Map(rows.map(({ oid, schema, name, columns }) => [oid, { schema, name, columns }]));
}
