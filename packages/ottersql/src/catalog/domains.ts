import type { Transaction } from "../sql/index.ts";
import { array, boolean, fields, nullable, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { checkBaseRow, domainChecksJson, parseDomainCheck } from "./checks.ts";
import type { CheckBaseRow } from "./checks.ts";
import { parseComment } from "./comments.ts";
import type { CatalogFeatures } from "./features.ts";
import type { Domain } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson, typeRow } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";
import { callsVolatile } from "./volatility.ts";

interface DomainRow {
  readonly schema: string;
  readonly name: string;
  readonly baseType: TypeRow;
  readonly baseTypeSql: string;
  readonly notNull: boolean;
  readonly default: string | null;
  readonly defaultVolatile: boolean;
  readonly checks: readonly CheckBaseRow[];
  readonly comment: string | null;
}

const domainRow: Shape<DomainRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    baseType: field("baseType", typeRow),
    baseTypeSql: field("baseTypeSql", string),
    notNull: field("notNull", boolean),
    default: field("default", nullable(string)),
    defaultVolatile: field("defaultVolatile", boolean),
    checks: field("checks", array(checkBaseRow)),
    comment: field("comment", nullable(string)),
  };
};

export async function readDomains(
  transaction: Transaction,
  features: CatalogFeatures,
): Promise<Domain[]> {
  const rows = await queryRows(transaction, {
    select: `select n.nspname as schema, t.typname as name,
        ${typeRefJson("t.typbasetype")} as "baseType",
        format_type(t.typbasetype, t.typtypmod) as "baseTypeSql",
        t.typnotnull as "notNull",
        t.typdefault as default,
        ${callsVolatile("t.typdefaultbin", "domain_default")} as "defaultVolatile",
        obj_description(t.oid, 'pg_type') as comment,
        ${domainChecksJson("t.oid", features)} as checks
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'd' and ${userObject("pg_type", "t.oid", "t.typnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: domainRow,
    label: "domains",
  });
  return rows.map((row) => ({
    schema: row.schema,
    name: row.name,
    baseType: parseTypeRef(row.baseType),
    baseTypeSql: row.baseTypeSql,
    notNull: row.notNull,
    default:
      row.default === null ? null : { expression: row.default, volatile: row.defaultVolatile },
    checks: row.checks.map((check) => parseDomainCheck(check)),
    comment: parseComment(row.comment),
  }));
}
