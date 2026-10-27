import { catalogRead, fields, nullable, string } from "./catalog-json.ts";
import type { CatalogRead, Shape } from "./catalog-json.ts";
import { parseComment } from "./comments.ts";
import type { RangeType } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson, typeRow } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface RangeRow {
  readonly schema: string;
  readonly name: string;
  readonly multirange: string;
  readonly subtype: TypeRow;
  readonly comment: string | null;
}

const rangeRow: Shape<RangeRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    multirange: field("multirange", string),
    subtype: field("subtype", typeRow),
    comment: field("comment", nullable(string)),
  };
};

export const rangesRead: CatalogRead<readonly RangeType[]> = catalogRead(
  {
    select: `select n.nspname as schema, t.typname as name, m.typname as multirange,
        ${typeRefJson("r.rngsubtype")} as subtype,
        obj_description(t.oid, 'pg_type') as comment
      from pg_range r
        join pg_type t on t.oid = r.rngtypid
        join pg_namespace n on n.oid = t.typnamespace
        join pg_type m on m.oid = r.rngmultitypid
      where ${userObject("pg_type", "t.oid", "t.typnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: rangeRow,
    label: "ranges",
  },
  (rows) =>
    rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      multirange: row.multirange,
      subtype: parseTypeRef(row.subtype),
      comment: parseComment(row.comment),
    })),
);
