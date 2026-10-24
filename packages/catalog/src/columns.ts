/**
 * Selects the names of the columns `attnums` of the relation `relationOid`, in the order given.
 * Its aliases start with `names_` so they cannot shadow the caller's.
 */
export function columnNames(relationOid: string, attnums: string): string {
  return `array(
    select names_attr.attname from unnest(${attnums}) with ordinality as names_key(attnum, ord)
    join pg_attribute names_attr
      on names_attr.attrelid = ${relationOid} and names_attr.attnum = names_key.attnum
    order by names_key.ord
  )`;
}
