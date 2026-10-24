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

const textCast = String.raw`::(?:character varying|text)`;
const literal = String.raw`'(?<body>(?:''|[^'])*)'${textCast}`;

/**
 * The string values a check allows for `subject`, when the check is exactly `subject IN (...)` as
 * Postgres prints it back. Any other shape, including numbers until their codec is settled (#2),
 * gives `null`: reading SQL beyond these printed forms would mean parsing it (ADR 0001).
 */
function allowedValues(expression: string, subject: string): string[] | null {
  const name = RegExp.escape(subject);
  const lhs = String.raw`(?:${name}|\(${name}\)::text)`;
  const single = new RegExp(String.raw`^\(${lhs} = ${literal}\)$`, "v").exec(expression);
  if (single?.groups?.["body"] !== undefined) {
    return [unquote(single.groups["body"])];
  }
  const list = new RegExp(
    String.raw`^\(${lhs} = ANY \(\(?ARRAY\[(?<items>.*?)\](?:\)::text\[\])?\)\)$`,
    "v",
  ).exec(expression);
  const items = list?.groups?.["items"];
  return items === undefined ? null : literals(items);
}

/** The values of a comma-separated list of string literals, or `null` if anything else is in it. */
function literals(list: string): string[] | null {
  const values: string[] = [];
  let end = 0;
  for (const match of list.matchAll(new RegExp(String.raw`${literal}(?:$|, )`, "gvy"))) {
    const body = match.groups?.["body"];
    if (body === undefined) {
      return null;
    }
    values.push(unquote(body));
    end = match.index + match[0].length;
  }
  return end === list.length ? values : null;
}

function unquote(body: string): string {
  return body.replaceAll("''", "'");
}
