/** Selects the names of the columns `attnums` of the relation `relationOid`, in the order given. */
export function columnNames(relationOid: string, attnums: string): string {
  return `array(
    select a.attname from unnest(${attnums}) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = ${relationOid} and a.attnum = k.attnum
    order by k.ord
  )`;
}
