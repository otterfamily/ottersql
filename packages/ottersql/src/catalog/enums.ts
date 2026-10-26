import type { Connection } from "../sql/index.ts";
import { array, fields, nullable, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { parseComment } from "./comments.ts";
import type { Enum } from "./model.ts";
import { userObject } from "./scope.ts";

const enumRow: Shape<EnumRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    values: field("values", array(string)),
    comment: field("comment", nullable(string)),
  };
};

export async function readEnums(connection: Connection): Promise<Enum[]> {
  const rows = await queryRows(connection, {
    select: `select n.nspname as schema, t.typname as name,
        array(select e.enumlabel from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder)
          as values,
        obj_description(t.oid, 'pg_type') as comment
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and ${userObject("pg_type", "t.oid", "t.typnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: enumRow,
    label: "enums",
  });
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    values: row.values,
    comment: parseComment(row.comment),
  }));
}

interface EnumRow {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly comment: string | null;
}
