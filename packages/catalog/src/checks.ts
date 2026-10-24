import { columnNames } from "./columns.ts";
import { parseEnforcement } from "./constraints.ts";
import type { Check } from "./model.ts";

/** Selects the check constraints of the table whose `pg_class` row is aliased `alias`, as `parseCheck` reads them. */
export function checksJson(alias: string): string {
  return `coalesce((
    select json_agg(json_build_object(
      'name', con.conname,
      'expression', pg_get_expr(con.conbin, con.conrelid),
      'columns', ${columnNames("con.conrelid", "con.conkey")},
      'quotedColumns', array(select quote_ident(name) from unnest(${columnNames("con.conrelid", "con.conkey")}) as name),
      'validated', con.convalidated,
      'enforced', con.conenforced
    ) order by con.conname)
    from pg_constraint con
    where con.conrelid = ${alias}.oid and con.contype = 'c'
  ), '[]') as checks`;
}

export interface CheckRow {
  readonly name: string;
  readonly expression: string;
  readonly columns: readonly string[];
  readonly quotedColumns: readonly string[];
  readonly validated: boolean;
  readonly enforced: boolean;
}

export function parseCheck(row: CheckRow): Check {
  const [column, ...others] = row.columns;
  const [quoted] = row.quotedColumns;
  const values =
    column !== undefined && quoted !== undefined && others.length === 0
      ? allowedValues(row.expression, quoted)
      : null;
  return {
    name: row.name,
    expression: row.expression,
    columns: row.columns,
    allowedValues: column !== undefined && values !== null ? { column, values } : null,
    enforcement: parseEnforcement(row),
  };
}

const textCast = String.raw`::(?:text|character varying)`;
const literal = String.raw`'((?:[^']|'')*)'${textCast}`;

/**
 * The string values a check allows for `subject`, when the check is exactly `subject IN (...)` as
 * Postgres prints it back. Any other shape, including numbers until their codec is settled (#2),
 * gives `null`: reading SQL beyond these printed forms would mean parsing it (ADR 0001).
 */
export function allowedValues(expression: string, subject: string): string[] | null {
  const lhs = String.raw`(?:${escape(subject)}|\(${escape(subject)}\)::text)`;
  const single = new RegExp(String.raw`^\(${lhs} = ${literal}\)$`).exec(expression);
  if (single?.[1] !== undefined) return [unquote(single[1])];

  const list = new RegExp(
    String.raw`^\(${lhs} = ANY \(\(?ARRAY\[(.*?)\](?:\)::text\[\])?\)\)$`,
  ).exec(expression);
  if (list?.[1] === undefined) return null;
  const items = new RegExp(String.raw`${literal}(?:, |$)`, "gy");
  const values: string[] = [];
  let end = 0;
  for (const match of list[1].matchAll(items)) {
    if (match[1] === undefined) return null;
    values.push(unquote(match[1]));
    end = match.index + match[0].length;
  }
  return end === list[1].length ? values : null;
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function unquote(body: string): string {
  return body.replaceAll("''", "'");
}
