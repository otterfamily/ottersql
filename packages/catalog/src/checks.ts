import { array, fields, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { columnNames } from "./columns.ts";
import { constraintState, constraintStateFields, parseEnforcement } from "./constraint-state.ts";
import type { ConstraintStateRow } from "./constraint-state.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Check, DomainCheck } from "./model.ts";

/**
 * Selects the fields `parseCheckBase` reads from the `pg_constraint` row `alias`, whose expression
 * is printed against `relationOid` (`0` for a domain).
 */
function checkFields(alias: string, relationOid: string, features: CatalogFeatures): string {
  return `'name', ${alias}.conname, 'expression', pg_get_expr(${alias}.conbin, ${relationOid}),
    ${constraintStateFields(alias, features)}`;
}

export interface CheckBaseRow extends ConstraintStateRow {
  readonly name: string;
  readonly expression: string;
}

/**
 * Selects the check constraints of the table `relationOid` as `parseTableCheck` reads them. Its
 * aliases start with `check_` so they cannot shadow the caller's.
 */
export function checksJson(relationOid: string, features: CatalogFeatures): string {
  return `coalesce((
    select json_agg(json_build_object(
      ${checkFields("check_con", "check_con.conrelid", features)},
      'columns', check_columns.names,
      'quotedColumns', array(select quote_ident(check_name) from unnest(check_columns.names) as check_name)
    ) order by check_con.conname)
    from pg_constraint check_con
    cross join lateral (
      select ${columnNames("check_con.conrelid", "check_con.conkey")} as names
    ) as check_columns
    where check_con.conrelid = ${relationOid} and check_con.contype = 'c'
  ), '[]')`;
}

/**
 * Selects the check constraints of the domain `typeOid` as `parseDomainCheck` reads them. Its
 * aliases start with `check_` so they cannot shadow the caller's.
 */
export function domainChecksJson(typeOid: string, features: CatalogFeatures): string {
  return `coalesce((
    select json_agg(json_build_object(${checkFields("check_con", "0", features)}) order by check_con.conname)
    from pg_constraint check_con
    where check_con.contypid = ${typeOid} and check_con.contype = 'c'
  ), '[]')`;
}

export interface TableCheckRow extends CheckBaseRow {
  readonly columns: readonly string[];
  readonly quotedColumns: readonly string[];
}

export const checkBaseRow: Shape<CheckBaseRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...constraintState(field),
    name: field("name", string),
    expression: field("expression", string),
  };
};

export const tableCheckRow: Shape<TableCheckRow> = (value, path) => {
  const field = fields(value, path);
  return {
    ...checkBaseRow(value, path),
    columns: field("columns", array(string)),
    quotedColumns: field("quotedColumns", array(string)),
  };
};

export function parseTableCheck(row: TableCheckRow): Check {
  const [column, ...others] = row.columns;
  const [quoted] = row.quotedColumns;
  const values =
    column === undefined || quoted === undefined || others.length > 0
      ? null
      : allowedValuesOf(row, quoted);
  return {
    ...parseCheckBase(row),
    columns: row.columns,
    allowedValues: column === undefined || values === null ? null : { column, values },
  };
}

export function parseDomainCheck(row: CheckBaseRow): DomainCheck {
  return { ...parseCheckBase(row), allowedValues: allowedValuesOf(row, "VALUE") };
}

function parseCheckBase(row: CheckBaseRow): Pick<Check, "name" | "expression" | "enforcement"> {
  return { name: row.name, expression: row.expression, enforcement: parseEnforcement(row) };
}

/** A check that does not hold for every existing row cannot narrow a type (ADR 0002). */
function allowedValuesOf(row: CheckBaseRow, subject: string): string[] | null {
  return parseEnforcement(row) === "validated" ? allowedValues(row.expression, subject) : null;
}

const textCast = String.raw`::(?:character varying|text)`;
const literal = String.raw`'(?<body>(?:''|[^'])*)'${textCast}`;

/**
 * The string values a check allows for `subject`, when the check is exactly `subject IN (...)` as
 * Postgres prints it back. Any other shape gives `null`: reading SQL beyond these printed forms
 * would mean parsing it (ADR 0001).
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
