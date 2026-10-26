import { fields, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";

/** The table a partition belongs to, and the bound of the rows it holds as Postgres prints it. */
export interface Partition {
  readonly schema: string;
  readonly table: string;
  readonly bound: string;
}

export const partitionRow: Shape<Partition> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    table: field("table", string),
    bound: field("bound", string),
  };
};

/** The partition key of the pg_class row `c` as Postgres prints it, or null for a table not partitioned. */
export function partitionedByJson(): string {
  return "case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end";
}

/**
 * The tables the pg_class row `c` inherits from (INHERITS), in the order it names them; a
 * partition's parent is in `partitionOfJson` instead.
 */
export function inheritsJson(): string {
  return `case when c.relispartition then '[]'::json else coalesce((
      select json_agg(json_build_object('schema', pn.nspname, 'name', p.relname) order by i.inhseqno)
      from pg_inherits i
      join pg_class p on p.oid = i.inhparent
      join pg_namespace pn on pn.oid = p.relnamespace
      where i.inhrelid = c.oid
    ), '[]') end`;
}

/** The table the pg_class row `c` is a partition of, with its bound, or null for one that is not. */
export function partitionOfJson(): string {
  return `case when c.relispartition then (
      select json_build_object(
        'schema', pn.nspname, 'table', p.relname, 'bound', pg_get_expr(c.relpartbound, c.oid))
      from pg_inherits i
      join pg_class p on p.oid = i.inhparent
      join pg_namespace pn on pn.oid = p.relnamespace
      where i.inhrelid = c.oid
    ) end`;
}
