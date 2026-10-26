import { array, boolean, fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { columnNames } from "./columns.ts";
import { parseComment } from "./comments.ts";
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
      'noInherit', check_con.connoinherit,
      'comment', obj_description(check_con.oid, 'pg_constraint'),
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
  readonly noInherit: boolean;
  readonly quotedColumns: readonly string[];
  readonly comment: string | null;
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
    noInherit: field("noInherit", boolean),
    quotedColumns: field("quotedColumns", array(string)),
    comment: field("comment", nullable(string)),
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
    notNullColumns: notNullColumns(row),
    noInherit: row.noInherit,
    comment: parseComment(row.comment),
  };
}

/** The columns a check proves non-null; none unless it holds for every row (ADR 0002). */
function notNullColumns(row: TableCheckRow): string[] {
  if (parseEnforcement(row) !== "validated") {
    return [];
  }
  const columns = new Map(row.quotedColumns.map((quoted, index) => [quoted, row.columns[index]]));
  return conjuncts(row.expression).flatMap((term) => {
    const quoted = /^\((?<column>.+) IS NOT NULL\)$/v.exec(term)?.groups?.["column"];
    const column = quoted === undefined ? undefined : columns.get(quoted);
    return column === undefined ? [] : [column];
  });
}

/**
 * The terms of a top-level AND as Postgres prints it, `((a IS NOT NULL) AND (b > 0))`, or the
 * expression itself. Only the parentheses and quotes Postgres prints are read (ADR 0001).
 */
function conjuncts(expression: string): string[] {
  const enclosed = expression.startsWith("(") && tokenEnd(expression, 0) === expression.length;
  const terms = enclosed ? topLevelTerms(expression.slice(1, -1), " AND ") : [];
  return terms.length > 1 ? terms : [expression];
}

/** `text` split at each `separator` outside parentheses and quotes, or `[text]` if one is open. */
function topLevelTerms(text: string, separator: string): string[] {
  const terms: string[] = [];
  let start = 0;
  let index = 0;
  while (index !== -1 && index < text.length) {
    if (text.startsWith(separator, index)) {
      terms.push(text.slice(start, index));
      index += separator.length;
      start = index;
    } else {
      index = tokenEnd(text, index);
    }
  }
  return index === -1 ? [text] : [...terms, text.slice(start)];
}

/**
 * Where the token at `index` ends: after quoted text, after a parenthesised group with what it
 * holds, or after one character; -1 when a quote or parenthesis is never closed.
 */
function tokenEnd(text: string, index: number): number {
  const character = text.charAt(index);
  if (character === "'" || character === '"') {
    const close = text.indexOf(character, index + 1);
    return close === -1 ? -1 : close + 1;
  }
  if (character !== "(") {
    return index + 1;
  }
  let end = index + 1;
  while (end !== -1 && end < text.length && text.charAt(end) !== ")") {
    end = tokenEnd(text, end);
  }
  return end === -1 || end >= text.length ? -1 : end + 1;
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
