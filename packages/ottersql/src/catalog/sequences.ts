import { boolean, catalogRead, fields, string } from "./catalog-json.ts";
import type { CatalogRead, Shape } from "./catalog-json.ts";
import type { Sequence } from "./model/table.ts";
import { userObject } from "./scope.ts";

export const sequenceRow: Shape<Sequence> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    dataType: field("dataType", string),
    start: field("start", string),
    increment: field("increment", string),
    minimum: field("minimum", string),
    maximum: field("maximum", string),
    cache: field("cache", string),
    cycle: field("cycle", boolean),
  };
};

/** The fields `sequenceRow` reads, for the pg_class row `sequenceClass` of a sequence in `namespace`. */
export function sequenceFields(sequenceClass: string, namespace: string): string {
  return `'schema', ${namespace}.nspname, 'name', ${sequenceClass}.relname,
      'dataType', format_type(seq.seqtypid, null),
      'start', seq.seqstart::text, 'increment', seq.seqincrement::text,
      'minimum', seq.seqmin::text, 'maximum', seq.seqmax::text,
      'cache', seq.seqcache::text, 'cycle', seq.seqcycle`;
}

/**
 * The sequences no column owns, such as one `CREATE SEQUENCE` makes for a default to call. Those
 * of `serial` and identity columns are read with their columns.
 */
export const sequencesRead: CatalogRead<readonly Sequence[]> = catalogRead(
  {
    select: `select json_build_object(${sequenceFields("c", "n")}) as sequence
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_sequence seq on seq.seqrelid = c.oid
      where c.relkind = 'S' and ${userObject("pg_class", "c.oid", "c.relnamespace")}
        and not exists (
          select from pg_depend owner
          where owner.classid = 'pg_class'::regclass and owner.objid = c.oid
            and owner.refobjsubid > 0 and owner.deptype in ('a', 'i')
        )`,
    orderBy: "rows.sequence->>'schema', rows.sequence->>'name'",
    row: (value, path) => fields(value, path)("sequence", sequenceRow),
    label: "sequences",
  },
  (rows) => rows,
);
