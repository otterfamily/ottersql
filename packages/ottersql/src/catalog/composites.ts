import type { Transaction } from "../sql/index.ts";
import { array, fields, nullable, qualifiedName, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { collationJson, columnBaseRow, columnsJson, parseColumnBase } from "./columns.ts";
import type { ColumnBaseRow } from "./columns.ts";
import { parseComment } from "./comments.ts";
import type { Comment, QualifiedName, ViewColumn } from "./model.ts";
import { scopeParameters, userObject } from "./scope.ts";

/** A composite type `CREATE TYPE ... AS (...)` makes; the row types of tables and views are not. */
export interface CompositeType {
  readonly schema: string;
  readonly name: string;
  readonly attributes: readonly CompositeAttribute[];
  readonly comment: Comment | null;
}

export interface CompositeAttribute extends ViewColumn {
  /** The attribute's collation, when it is not the one its type has. */
  readonly collation: QualifiedName | null;
}

interface AttributeRow extends ColumnBaseRow {
  readonly collation: QualifiedName | null;
}

interface CompositeRow {
  readonly schema: string;
  readonly name: string;
  readonly attributes: readonly AttributeRow[];
  readonly comment: string | null;
}

const attributeRow: Shape<AttributeRow> = (value, path) => ({
  ...columnBaseRow(value, path),
  collation: fields(value, path)("collation", nullable(qualifiedName)),
});

const compositeRow: Shape<CompositeRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    attributes: field("attributes", array(attributeRow)),
    comment: field("comment", nullable(string)),
  };
};

export async function readComposites(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<CompositeType[]> {
  // A standalone composite type has a pg_class row of its own, of kind 'c'.
  const rows = await queryRows(transaction, {
    select: `select n.nspname as schema, t.typname as name,
        ${columnsJson("c.oid", collationJson)} as attributes,
        obj_description(t.oid, 'pg_type') as comment
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      join pg_class c on c.oid = t.typrelid
      where t.typtype = 'c' and c.relkind = 'c'
        and ${userObject("pg_type", "t.oid", "t.typnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: compositeRow,
    label: "composite types",
    parameters: scopeParameters(omitSchemas),
  });
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    attributes: row.attributes.map((attribute) => ({
      ...parseColumnBase(attribute),
      collation: attribute.collation,
    })),
    comment: parseComment(row.comment),
  }));
}
