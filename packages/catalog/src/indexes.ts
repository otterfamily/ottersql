import { array, boolean, fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { columnNames } from "./columns.ts";
import type { Index, IndexKey, QualifiedName } from "./model.ts";

/**
 * Selects the indexes of the table `relationOid` as `parseIndex` reads them. Indexes that back a
 * primary key or unique constraint are left out, since the constraint describes them. Its aliases
 * start with `idx_` so they cannot shadow the caller's.
 */
export function indexesJson(relationOid: string): string {
  return `coalesce((
    select json_agg(json_build_object(
      'name', idx_class.relname,
      'method', idx_am.amname,
      'unique', idx.indisunique,
      'nullsNotDistinct', idx.indnullsnotdistinct,
      'keys', (
        select json_agg(json_build_object(
          'column', idx_attr.attname,
          'definition', pg_get_indexdef(idx.indexrelid, idx_key.pos, true),
          'descending', (idx.indoption[idx_key.pos - 1] & 1) <> 0,
          'nullsFirst', (idx.indoption[idx_key.pos - 1] & 2) <> 0,
          'operatorClass', case when not idx_opclass.opcdefault then json_build_object(
            'schema', idx_opclass_ns.nspname, 'name', idx_opclass.opcname
          ) end,
          'collation', case
            when idx.indcollation[idx_key.pos - 1] not in (0, coalesce(idx_attr.attcollation, 100))
            then json_build_object('schema', idx_coll_ns.nspname, 'name', idx_coll.collname)
          end
        ) order by idx_key.pos)
        from generate_series(1, idx.indnkeyatts) as idx_key(pos)
        join pg_opclass idx_opclass on idx_opclass.oid = idx.indclass[idx_key.pos - 1]
        join pg_namespace idx_opclass_ns on idx_opclass_ns.oid = idx_opclass.opcnamespace
        left join pg_attribute idx_attr
          on idx_attr.attrelid = idx.indrelid and idx_attr.attnum = idx.indkey[idx_key.pos - 1]
        left join pg_collation idx_coll on idx_coll.oid = idx.indcollation[idx_key.pos - 1]
        left join pg_namespace idx_coll_ns on idx_coll_ns.oid = idx_coll.collnamespace
      ),
      'include', ${columnNames(
        "idx.indrelid",
        "(idx.indkey::int2[])[idx.indnkeyatts : idx.indnatts - 1]",
      )},
      'predicate', pg_get_expr(idx.indpred, idx.indrelid)
    ) order by idx_class.relname)
    from pg_index idx
    join pg_class idx_class on idx_class.oid = idx.indexrelid
    join pg_am idx_am on idx_am.oid = idx_class.relam
    where idx.indrelid = ${relationOid} and not exists (
      select from pg_constraint idx_con
      where idx_con.conrelid = idx.indrelid and idx_con.conindid = idx.indexrelid
        and idx_con.contype in ('p', 'u')
    )
  ), '[]')`;
}

export interface IndexRow {
  readonly name: string;
  readonly method: string;
  readonly unique: boolean;
  readonly nullsNotDistinct: boolean;
  readonly keys: readonly IndexKeyRow[];
  readonly include: readonly string[];
  readonly predicate: string | null;
}

interface IndexKeyRow {
  readonly column: string | null;
  readonly definition: string;
  readonly descending: boolean;
  readonly nullsFirst: boolean;
  readonly operatorClass: QualifiedName | null;
  readonly collation: QualifiedName | null;
}

const qualifiedName: Shape<QualifiedName> = (value, path) => {
  const field = fields(value, path);
  return { schema: field("schema", string), name: field("name", string) };
};

const indexKeyRow: Shape<IndexKeyRow> = (value, path) => {
  const field = fields(value, path);
  return {
    column: field("column", nullable(string)),
    definition: field("definition", string),
    descending: field("descending", boolean),
    nullsFirst: field("nullsFirst", boolean),
    operatorClass: field("operatorClass", nullable(qualifiedName)),
    collation: field("collation", nullable(qualifiedName)),
  };
};

export const indexRow: Shape<IndexRow> = (value, path) => {
  const field = fields(value, path);
  return {
    name: field("name", string),
    method: field("method", string),
    unique: field("unique", boolean),
    nullsNotDistinct: field("nullsNotDistinct", boolean),
    keys: field("keys", array(indexKeyRow)),
    include: field("include", array(string)),
    predicate: field("predicate", nullable(string)),
  };
};

export function parseIndex(row: IndexRow): Index {
  return {
    name: row.name,
    method: row.method,
    unique: row.unique,
    nullsNotDistinct: row.nullsNotDistinct,
    keys: row.keys.map((key) => parseIndexKey(key)),
    include: row.include,
    predicate: row.predicate,
  };
}

function parseIndexKey(row: IndexKeyRow): IndexKey {
  const options = {
    order: row.descending ? "desc" : "asc",
    nulls: row.nullsFirst ? "first" : "last",
    operatorClass: row.operatorClass,
    collation: row.collation,
  } as const;
  return row.column === null
    ? { kind: "expression", expression: row.definition, ...options }
    : { kind: "column", column: row.column, ...options };
}
