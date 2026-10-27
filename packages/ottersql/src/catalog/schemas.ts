import { catalogRead, fields, nullable, string } from "./catalog-json.ts";
import type { CatalogRead, Shape } from "./catalog-json.ts";
import { parseComment } from "./comments.ts";
import type { Schema } from "./model.ts";
import { userObject } from "./scope.ts";

interface SchemaRow {
  readonly name: string;
  readonly comment: string | null;
}

const schemaRow: Shape<SchemaRow> = (value, path) => {
  const field = fields(value, path);
  return { name: field("name", string), comment: field("comment", nullable(string)) };
};

export const schemasRead: CatalogRead<readonly Schema[]> = catalogRead(
  {
    select: `select n.nspname as name, obj_description(n.oid, 'pg_namespace') as comment
      from pg_namespace n
      where ${userObject("pg_namespace", "n.oid", "n.oid")}`,
    orderBy: "rows.name",
    row: schemaRow,
    label: "schemas",
  },
  (rows) => rows.map((row) => ({ name: row.name, comment: parseComment(row.comment) })),
);
