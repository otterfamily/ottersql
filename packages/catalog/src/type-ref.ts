import { fields, nullable, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import type { NamedTypeRef, TypeRef } from "./model.ts";

/**
 * Selects the columns `parseTypeRef` reads, for the type whose oid is `oidExpression`. Its aliases
 * start with `ref_` so they cannot shadow the caller's.
 */
export function typeRefJson(oidExpression: string): string {
  return `(
    select json_build_object(
      'typtype', ref_type.typtype, 'schema', ref_ns.nspname, 'name', ref_type.typname,
      'element', case when ref_type.typinput = 'array_in'::regproc then (
        select json_build_object(
          'typtype', ref_elem.typtype, 'schema', ref_elem_ns.nspname, 'name', ref_elem.typname
        )
        from pg_type ref_elem join pg_namespace ref_elem_ns on ref_elem_ns.oid = ref_elem.typnamespace
        where ref_elem.oid = ref_type.typelem
      ) end
    )
    from pg_type ref_type join pg_namespace ref_ns on ref_ns.oid = ref_type.typnamespace
    where ref_type.oid = ${oidExpression}
  )`;
}

export interface TypeRow {
  readonly typtype: string;
  readonly schema: string;
  readonly name: string;
  readonly element: Omit<TypeRow, "element"> | null;
}

const namedTypeRow: Shape<Omit<TypeRow, "element">> = (value, path) => {
  const field = fields(value, path);
  return {
    typtype: field("typtype", string),
    schema: field("schema", string),
    name: field("name", string),
  };
};

export const typeRow: Shape<TypeRow> = (value, path) => ({
  ...namedTypeRow(value, path),
  element: fields(value, path)("element", nullable(namedTypeRow)),
});

export function parseTypeRef(row: TypeRow): TypeRef {
  if (row.element !== null) {
    return { kind: "array", element: parseNamedTypeRef(row.element) };
  }
  return parseNamedTypeRef(row);
}

function parseNamedTypeRef(row: Omit<TypeRow, "element">): NamedTypeRef {
  return {
    kind: decode(typeKinds, row.typtype, "pg_type.typtype"),
    schema: row.schema,
    name: row.name,
  };
}

const typeKinds = {
  b: "base",
  c: "composite",
  d: "domain",
  e: "enum",
  m: "multirange",
  p: "pseudo",
  r: "range",
} as const satisfies Record<string, NamedTypeRef["kind"]>;
