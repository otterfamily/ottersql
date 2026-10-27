import type { Catalog } from "./model/catalog.ts";
import type { QualifiedName, TypeRef } from "./model/shared.ts";
import type { ForeignKey, Table } from "./model/table.ts";
import type { Domain, Enum, RangeType } from "./model/types.ts";

/** A catalog's objects by schema-qualified name, for lookups that would otherwise scan a list. */
interface ByName {
  readonly tables: ReadonlyMap<string, Table>;
  readonly domains: ReadonlyMap<string, Domain>;
  readonly enums: ReadonlyMap<string, Enum>;
  /** Each range type under its own name and under its multirange type's. */
  readonly ranges: ReadonlyMap<string, RangeType>;
}

// Catalogs are not changed once read, so an index made for one stays right.
const indexes = new WeakMap<Catalog, ByName>();

/** A key for a schema-qualified name; joining with a dot would give `"a.b".c` and `a."b.c"` one key. */
export function nameKey(schema: string, name: string): string {
  // Postgres names never hold a NUL, so no two names share a key.
  return `${schema}\0${name}`;
}

function byName(catalog: Catalog): ByName {
  const known = indexes.get(catalog);
  if (known !== undefined) {
    return known;
  }
  const index: ByName = {
    tables: new Map(catalog.tables.map((table) => [nameKey(table.schema, table.name), table])),
    domains: new Map(
      catalog.domains.map((domain) => [nameKey(domain.schema, domain.name), domain]),
    ),
    enums: new Map(catalog.enums.map((type) => [nameKey(type.schema, type.name), type])),
    ranges: new Map(
      catalog.ranges.flatMap((range) => [
        [nameKey(range.schema, range.multirange), range],
        [nameKey(range.schema, range.name), range],
      ]),
    ),
  };
  indexes.set(catalog, index);
  return index;
}

export function findTable(catalog: Catalog, schema: string, name: string): Table | undefined {
  return byName(catalog).tables.get(nameKey(schema, name));
}

export function findDomain(catalog: Catalog, schema: string, name: string): Domain | undefined {
  return byName(catalog).domains.get(nameKey(schema, name));
}

export function findEnum(catalog: Catalog, schema: string, name: string): Enum | undefined {
  return byName(catalog).enums.get(nameKey(schema, name));
}

/** The range type named `name`, or the one whose multirange type is named `name`. */
export function findRange(catalog: Catalog, schema: string, name: string): RangeType | undefined {
  return byName(catalog).ranges.get(nameKey(schema, name));
}

export function sameType(left: TypeRef, right: TypeRef): boolean {
  if (left.kind === "array" || right.kind === "array") {
    return left.kind === "array" && right.kind === "array" && sameType(left.element, right.element);
  }
  return left.kind === right.kind && left.schema === right.schema && left.name === right.name;
}

/** Whether `key` refers to `table`. */
export function referencesTable(key: ForeignKey, table: QualifiedName): boolean {
  return key.references.schema === table.schema && key.references.table === table.name;
}
