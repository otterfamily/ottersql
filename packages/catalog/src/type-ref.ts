import type { NamedTypeRef, TypeRef } from "./model.ts";

/** Selects the columns `parseTypeRef` reads, for the type whose oid is `oidExpression`. */
export function typeRefJson(oidExpression: string): string {
  return `(
    select json_build_object(
      'typtype', t.typtype, 'schema', tn.nspname, 'name', t.typname,
      'element', case when t.typcategory = 'A' and t.typelem <> 0 then (
        select json_build_object('typtype', e.typtype, 'schema', en.nspname, 'name', e.typname)
        from pg_type e join pg_namespace en on en.oid = e.typnamespace
        where e.oid = t.typelem
      ) end
    )
    from pg_type t join pg_namespace tn on tn.oid = t.typnamespace
    where t.oid = ${oidExpression}
  )`;
}

export interface TypeRow {
  readonly typtype: string;
  readonly schema: string;
  readonly name: string;
  readonly element: Omit<TypeRow, "element"> | null;
}

export function parseTypeRef(row: TypeRow): TypeRef {
  if (row.element !== null) {
    return { kind: "array", element: parseNamedTypeRef(row.element) };
  }
  return parseNamedTypeRef(row);
}

function parseNamedTypeRef(row: Omit<TypeRow, "element">): NamedTypeRef {
  return { kind: typeKind(row.typtype), schema: row.schema, name: row.name };
}

function typeKind(typtype: string): NamedTypeRef["kind"] {
  switch (typtype) {
    case "b": {
      return "base";
    }
    case "c": {
      return "composite";
    }
    case "d": {
      return "domain";
    }
    case "e": {
      return "enum";
    }
    case "m": {
      return "multirange";
    }
    case "p": {
      return "pseudo";
    }
    case "r": {
      return "range";
    }
    default: {
      throw new Error(`unknown pg_type.typtype ${JSON.stringify(typtype)}`);
    }
  }
}
