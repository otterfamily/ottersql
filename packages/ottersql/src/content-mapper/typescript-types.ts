import type { Catalog, NamedTypeRef, TypeRef } from "../catalog/index.ts";
import { findDomain, findEnum, findRange } from "../catalog/internal.ts";
import { baseCodecs, rangeSubtypes } from "../sql/internal.ts";

/** Types the rendered module imports from `ottersql` when it uses them. */
export type SqlTypeImport = "Interval" | "Json" | "Range";

export interface TypeContext {
  readonly catalog: Catalog;
  /** Values ottersql decodes from Postgres (`output`) or encodes for it (`input`; see `BaseCodec`). */
  readonly direction: "input" | "output";
  /** Collects the `ottersql` types the rendered text refers to. */
  readonly imports: Set<SqlTypeImport>;
}

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
  // An enum an extension defines is not in the catalog, so its values are unknown.
  enum: (type, context) => {
    const values = findEnum(context.catalog, type.schema, type.name)?.values;
    return values === undefined ? "string" : literalUnion(values);
  },
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
  const codec = type.schema === "pg_catalog" ? baseCodecs[type.name] : undefined;
  const base =
    (context.direction === "input" ? codec?.parameterType : undefined) ?? codec?.type ?? "string";
  if (base === "Interval" || base === "Json") {
    context.imports.add(base);
  }
  return base;
}

function domainType(type: NamedTypeRef, context: TypeContext): string {
  const domain = findDomain(context.catalog, type.schema, type.name);
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
  const builtIn = type.schema === "pg_catalog" ? rangeSubtypes.get(type.name) : undefined;
  const subtype =
    builtIn === undefined
      ? findRange(context.catalog, type.schema, type.name)?.subtype
      : { kind: "base" as const, schema: "pg_catalog", name: builtIn };
  const boundType = subtype === undefined ? "string" : tsType(subtype, context);
  return type.kind === "range" ? `Range<${boundType}>` : `Range<${boundType}>[]`;
}
