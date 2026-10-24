import type { Catalog, Domain, Enum, Table, TypeRef } from "./model.ts";

export function findTable(catalog: Catalog, schema: string, name: string): Table | undefined {
  return catalog.tables.find((table) => table.schema === schema && table.name === name);
}

export function findDomain(catalog: Catalog, schema: string, name: string): Domain | undefined {
  return catalog.domains.find((domain) => domain.schema === schema && domain.name === name);
}

export function findEnum(catalog: Catalog, schema: string, name: string): Enum | undefined {
  return catalog.enums.find((candidate) => candidate.schema === schema && candidate.name === name);
}

export function sameType(left: TypeRef, right: TypeRef): boolean {
  if (left.kind === "array" || right.kind === "array") {
    return left.kind === "array" && right.kind === "array" && sameType(left.element, right.element);
  }
  return left.kind === right.kind && left.schema === right.schema && left.name === right.name;
}
