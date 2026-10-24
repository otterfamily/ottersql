import type { Catalog, NamedTypeRef, TypeRef } from "@ottersql/catalog";

/** Types the rendered module imports from `@ottersql/sql` when it uses them. */
export type SqlTypeImport = "Interval" | "Range";

export interface TypeContext {
  readonly catalog: Catalog;
  /** Collects the `@ottersql/sql` types the rendered text refers to. */
  readonly imports: Set<SqlTypeImport>;
}

// ADR 0008's default codecs. Types without a codec arrive as Postgres's text.
const baseTypes: Readonly<Record<string, string>> = {
  bool: "boolean",
  bytea: "Uint8Array",
  date: "Temporal.PlainDate",
  float4: "number",
  float8: "number",
  int2: "number",
  int4: "number",
  interval: "Interval",
  json: "unknown",
  jsonb: "unknown",
  oid: "number",
  time: "Temporal.PlainTime",
  timestamp: "Temporal.PlainDateTime",
  timestamptz: "Temporal.Instant",
};

const rangeBounds: Readonly<Record<string, string>> = {
  daterange: "date",
  datemultirange: "date",
  int4range: "int4",
  int4multirange: "int4",
  int8range: "int8",
  int8multirange: "int8",
  numrange: "numeric",
  nummultirange: "numeric",
  tsrange: "timestamp",
  tsmultirange: "timestamp",
  tstzrange: "timestamptz",
  tstzmultirange: "timestamptz",
};

/** The TypeScript type of a non-null value of `type`. */
export function tsType(type: TypeRef, context: TypeContext): string {
  if (type.kind === "array") {
    return `(${tsType(type.element, context)} | null)[]`;
  }
  return namedType(type, context);
}

/** `type`, or `type | null` unless `type` already admits null. */
export function nullable(type: string): string {
  return type === "unknown" ? type : `${type} | null`;
}

/** A union of string literals, as an enum or a check that lists the allowed values produces. */
export function literalUnion(values: readonly string[]): string {
  return values.length === 0 ? "never" : values.map((value) => JSON.stringify(value)).join(" | ");
}

const namedTypes: Readonly<
  Record<NamedTypeRef["kind"], (type: NamedTypeRef, context: TypeContext) => string>
> = {
  base: (type, context) => baseType(type, context),
  enum: (type, context) => literalUnion(findEnum(type, context.catalog)?.values ?? []),
  domain: (type, context) => domainType(type, context),
  range: (type, context) => rangeType(type, context),
  multirange: (type, context) => rangeType(type, context),
  // Without a codec, composite and pseudo-typed values arrive as Postgres's text.
  composite: () => "string",
  pseudo: () => "string",
};

function namedType(type: NamedTypeRef, context: TypeContext): string {
  return namedTypes[type.kind](type, context);
}

function baseType(type: NamedTypeRef, context: TypeContext): string {
  const base = type.schema === "pg_catalog" ? (baseTypes[type.name] ?? "string") : "string";
  if (base === "Interval") {
    context.imports.add("Interval");
  }
  return base;
}

function domainType(type: NamedTypeRef, context: TypeContext): string {
  const domain = context.catalog.domains.find(
    (candidate) => candidate.schema === type.schema && candidate.name === type.name,
  );
  if (domain === undefined) {
    return "string";
  }
  const allowed = domain.checks.find((check) => check.allowedValues !== null)?.allowedValues;
  return allowed === null || allowed === undefined
    ? tsType(domain.baseType, context)
    : literalUnion(allowed);
}

function rangeType(type: NamedTypeRef, context: TypeContext): string {
  context.imports.add("Range");
  const bound = type.schema === "pg_catalog" ? rangeBounds[type.name] : undefined;
  const boundType =
    bound === undefined
      ? "string"
      : namedType({ kind: "base", schema: "pg_catalog", name: bound }, context);
  return type.kind === "range" ? `Range<${boundType}>` : `Range<${boundType}>[]`;
}

function findEnum(
  type: NamedTypeRef,
  catalog: Catalog,
): { readonly values: readonly string[] } | undefined {
  return catalog.enums.find(
    (candidate) => candidate.schema === type.schema && candidate.name === type.name,
  );
}
