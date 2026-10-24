import { decode } from "./codes.ts";
import { columnNames } from "./columns.ts";
import { constraintStateFields, parseDeferral, parseEnforcement } from "./constraint-state.ts";
import type { ConstraintStateRow } from "./constraint-state.ts";
import type { ForeignKey, Table } from "./model.ts";

/**
 * Selects the primary key, unique constraints and foreign keys of the table `relationOid` as the
 * columns `parseKeys` reads. Its aliases start with `key_` so they cannot shadow the caller's.
 */
export function keysJson(relationOid: string): string {
  const indexed = `
    'name', key_con.conname,
    'columns', ${columnNames("key_con.conrelid", "key_con.conkey")},
    'include', ${columnNames("key_index.indrelid", "(key_index.indkey::int2[])[key_index.indnkeyatts : key_index.indnatts - 1]")},
    'nullsNotDistinct', key_index.indnullsnotdistinct,
    ${constraintStateFields("key_con")}`;
  const indexedOf = (contype: string): string => `
    from pg_constraint key_con join pg_index key_index on key_index.indexrelid = key_con.conindid
    where key_con.conrelid = ${relationOid} and key_con.contype = '${contype}'`;
  return `
    (select json_build_object(${indexed}) ${indexedOf("p")}) as "primaryKey",
    coalesce((
      select json_agg(json_build_object(${indexed}) order by key_con.conname) ${indexedOf("u")}
    ), '[]') as "uniqueConstraints",
    coalesce((
      select json_agg(json_build_object(
        'name', key_con.conname,
        'columns', ${columnNames("key_con.conrelid", "key_con.conkey")},
        'referencedSchema', key_ref_ns.nspname,
        'referencedTable', key_ref.relname,
        'referencedColumns', ${columnNames("key_con.confrelid", "key_con.confkey")},
        'match', key_con.confmatchtype,
        'onUpdate', key_con.confupdtype,
        'onDelete', key_con.confdeltype,
        ${constraintStateFields("key_con")}
      ) order by key_con.conname)
      from pg_constraint key_con
      join pg_class key_ref on key_ref.oid = key_con.confrelid
      join pg_namespace key_ref_ns on key_ref_ns.oid = key_ref.relnamespace
      where key_con.conrelid = ${relationOid} and key_con.contype = 'f'
    ), '[]') as "foreignKeys"`;
}

export interface KeyRows {
  readonly primaryKey: IndexedKeyRow | null;
  readonly uniqueConstraints: readonly IndexedKeyRow[];
  readonly foreignKeys: readonly ForeignKeyRow[];
}

interface IndexedKeyRow extends ConstraintStateRow {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
}

interface ForeignKeyRow extends ConstraintStateRow {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedSchema: string;
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly match: string;
  readonly onUpdate: string;
  readonly onDelete: string;
}

export function parseKeys(
  rows: KeyRows,
): Pick<Table, "primaryKey" | "uniqueConstraints" | "foreignKeys"> {
  return {
    primaryKey:
      rows.primaryKey === null
        ? null
        : {
            name: rows.primaryKey.name,
            columns: rows.primaryKey.columns,
            include: rows.primaryKey.include,
            deferral: parseDeferral(rows.primaryKey),
          },
    uniqueConstraints: rows.uniqueConstraints.map((row) => ({
      name: row.name,
      columns: row.columns,
      include: row.include,
      nullsNotDistinct: row.nullsNotDistinct,
      deferral: parseDeferral(row),
    })),
    foreignKeys: rows.foreignKeys.map((row) => parseForeignKey(row)),
  };
}

const matchTypes = { f: "full", p: "partial", s: "simple" } as const;
const actions = {
  a: "no action",
  c: "cascade",
  d: "set default",
  n: "set null",
  r: "restrict",
} as const;

function parseForeignKey(row: ForeignKeyRow): ForeignKey {
  return {
    name: row.name,
    columns: row.columns,
    references: {
      schema: row.referencedSchema,
      table: row.referencedTable,
      columns: row.referencedColumns,
    },
    match: decode(matchTypes, row.match, "pg_constraint.confmatchtype"),
    onUpdate: decode(actions, row.onUpdate, "pg_constraint.confupdtype"),
    onDelete: decode(actions, row.onDelete, "pg_constraint.confdeltype"),
    deferral: parseDeferral(row),
    enforcement: parseEnforcement(row),
  };
}
