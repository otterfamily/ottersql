import type { Transaction } from "../sql/index.ts";
import { fields, nullable, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { parseComment } from "./comments.ts";
import type { Schema } from "./model.ts";
import { scopeParameters, userObject } from "./scope.ts";

interface SchemaRow {
  readonly name: string;
  readonly comment: string | null;
}

const schemaRow: Shape<SchemaRow> = (value, path) => {
  const field = fields(value, path);
  return { name: field("name", string), comment: field("comment", nullable(string)) };
};

export async function readSchemas(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<Schema[]> {
  const rows = await queryRows(transaction, {
    select: `select n.nspname as name, obj_description(n.oid, 'pg_namespace') as comment
      from pg_namespace n
      where ${userObject("pg_namespace", "n.oid", "n.oid")}`,
    orderBy: "rows.name",
    row: schemaRow,
    label: "schemas",
    parameters: scopeParameters(omitSchemas),
  });
  return rows.map((row) => ({ name: row.name, comment: parseComment(row.comment) }));
}
