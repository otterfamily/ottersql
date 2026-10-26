import type {
  Column,
  Deferral,
  Enforcement,
  ForeignKey,
  Index,
  IndexKey,
  QualifiedName,
} from "../catalog/index.ts";

/** Always quoted, so no name can be read as a keyword or folded to lower case. */
export function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualified(schema: string, name: string): string {
  return `${identifier(schema)}.${identifier(name)}`;
}

export function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function columnList(names: readonly string[]): string {
  return `(${names.map((name) => identifier(name)).join(", ")})`;
}

export function columnDefinition(column: Column): string {
  const { value } = column;
  const parts = [identifier(column.name), column.typeSql];
  if (value.kind === "default") {
    parts.push(`DEFAULT ${value.expression}`);
  } else if (value.kind === "identity") {
    parts.push(`GENERATED ${value.generation.toUpperCase()} AS IDENTITY`);
  } else if (value.kind === "generated") {
    parts.push(`GENERATED ALWAYS AS (${value.expression}) ${value.storage.toUpperCase()}`);
  }
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  return parts.join(" ");
}

export function deferral(value: Deferral): string {
  return value === "not deferrable" ? "" : ` DEFERRABLE ${value.toUpperCase()}`;
}

/** The clause that makes a constraint skip existing rows or every row. */
export function enforcement(value: Enforcement): string {
  return value === "validated" ? "" : ` ${value.toUpperCase()}`;
}

export function foreignKeyDefinition(key: ForeignKey): string {
  const { references } = key;
  const match = key.match === "simple" ? "" : ` MATCH ${key.match.toUpperCase()}`;
  return [
    `FOREIGN KEY ${columnList(key.columns)}`,
    ` REFERENCES ${qualified(references.schema, references.table)} ${columnList(references.columns)}`,
    match,
    ` ON UPDATE ${key.onUpdate.toUpperCase()} ON DELETE ${key.onDelete.toUpperCase()}`,
    deferral(key.deferral),
  ].join("");
}

function qualifiedName(name: QualifiedName): string {
  return qualified(name.schema, name.name);
}

function indexKey(key: IndexKey): string {
  const target = key.kind === "column" ? identifier(key.column) : `(${key.expression})`;
  const collation = key.collation === null ? "" : ` COLLATE ${qualifiedName(key.collation)}`;
  const operatorClass = key.operatorClass === null ? "" : ` ${qualifiedName(key.operatorClass)}`;
  const order = key.order === "desc" ? " DESC" : "";
  // Postgres sorts nulls last ascending and first descending unless told otherwise.
  const defaultNulls = key.order === "desc" ? "first" : "last";
  const nulls = key.nulls === defaultNulls ? "" : ` NULLS ${key.nulls.toUpperCase()}`;
  return `${target}${collation}${operatorClass}${order}${nulls}`;
}

export function createIndex(table: QualifiedName, index: Index, concurrently: boolean): string {
  return [
    `CREATE${index.unique ? " UNIQUE" : ""} INDEX${concurrently ? " CONCURRENTLY" : ""}`,
    ` ${identifier(index.name)} ON ${qualifiedName(table)} USING ${index.method}`,
    ` (${index.keys.map((key) => indexKey(key)).join(", ")})`,
    index.include.length > 0 ? ` INCLUDE ${columnList(index.include)}` : "",
    index.nullsNotDistinct ? " NULLS NOT DISTINCT" : "",
    index.predicate === null ? "" : ` WHERE ${index.predicate}`,
  ].join("");
}

// Postgres truncates longer names, so a longer name ottersql makes up would not be the one it uses.
const MAX_NAME_BYTES = 63;

/** Whether `name` is too long for Postgres to keep whole. */
export function exceedsNameLimit(name: string): boolean {
  return new TextEncoder().encode(name).length > MAX_NAME_BYTES;
}

export function alterTable(table: QualifiedName, action: string): string {
  return `ALTER TABLE ${qualified(table.schema, table.name)} ${action}`;
}

export function columnSqlName(table: QualifiedName, column: string): string {
  return `${qualified(table.schema, table.name)}.${identifier(column)}`;
}

/** Re-runnable: a run that dropped the index but failed before recording it finds it gone. */
export function dropIndexStatement(table: QualifiedName, index: string): string {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${qualified(table.schema, index)}`;
}
