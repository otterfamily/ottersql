import type {
  Check,
  Column,
  Comment,
  Deferral,
  Enforcement,
  ForeignKey,
  Index,
  IndexKey,
  QualifiedName,
  Sequence,
} from "../catalog/index.ts";

/** Always quoted, so no name can be read as a keyword or folded to lower case. */
export function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualified(schema: string, name: string): string {
  return `${identifier(schema)}.${identifier(name)}`;
}

/** A string constant that reads back as `text` whether or not standard_conforming_strings is on. */
export function literal(text: string): string {
  const quoted = text.replaceAll("'", "''");
  // With the setting off, a backslash in '...' starts an escape; in E'...' it always does.
  return text.includes("\\") ? `E'${quoted.replaceAll("\\", String.raw`\\`)}'` : `'${quoted}'`;
}

export function columnList(names: readonly string[]): string {
  return `(${names.map((name) => identifier(name)).join(", ")})`;
}

/** A key's columns, the last one marked WITHOUT OVERLAPS when the key says so. */
export function keyColumnList(key: {
  readonly columns: readonly string[];
  readonly withoutOverlaps: boolean;
}): string {
  const list = columnList(key.columns);
  return key.withoutOverlaps ? `${list.slice(0, -1)} WITHOUT OVERLAPS)` : list;
}

/** A foreign key's columns on one side, the last one marked PERIOD when `period` says so. */
function foreignKeyColumnList(names: readonly string[], period: boolean): string {
  const quoted = names.map((name) => identifier(name));
  const last = quoted.length - 1;
  return `(${quoted.map((name, index) => (period && index === last ? `PERIOD ${name}` : name)).join(", ")})`;
}

/** A column as `CREATE TABLE` and `ADD COLUMN` write it, without its storage (see `setStorage`). */
export function columnDefinition(column: Column): string {
  const value = valueClause(column.value);
  const { collation, compression } = column;
  return [
    identifier(column.name),
    column.typeSql,
    ...(compression === null ? [] : [`COMPRESSION ${compression}`]),
    ...(collation === null ? [] : [`COLLATE ${qualified(collation.schema, collation.name)}`]),
    ...(value === null ? [] : [value]),
    ...(column.notNull ? [column.notNullNoInherit ? "NOT NULL NO INHERIT" : "NOT NULL"] : []),
  ].join(" ");
}

/**
 * The `ALTER TABLE` action that gives a column its storage, or none when it has its type's.
 * Postgres 15 has no `STORAGE` clause in a column definition, but has always had this action.
 */
export function setStorage(column: Column): string[] {
  return column.storage === null
    ? []
    : [`ALTER COLUMN ${identifier(column.name)} SET STORAGE ${column.storage.toUpperCase()}`];
}

/** A check as `ADD CONSTRAINT` and `CREATE TABLE` write it, without its name or enforcement. */
export function checkDefinition(check: Pick<Check, "expression" | "noInherit">): string {
  return `CHECK (${check.expression})${check.noInherit ? " NO INHERIT" : ""}`;
}

function valueClause(value: Column["value"]): string | null {
  if (value.kind === "default") {
    return `DEFAULT ${value.expression}`;
  }
  if (value.kind === "sequence") {
    return `DEFAULT nextval(${literal(qualified(value.sequence.schema, value.sequence.name))}::regclass)`;
  }
  if (value.kind === "identity") {
    const { sequence } = value;
    return `GENERATED ${value.generation.toUpperCase()} AS IDENTITY (SEQUENCE NAME ${qualified(sequence.schema, sequence.name)} ${sequenceSettings(sequence)})`;
  }
  return value.kind === "generated"
    ? `GENERATED ALWAYS AS (${value.expression}) ${value.storage.toUpperCase()}`
    : null;
}

/** A sequence's settings, every one spelled out, as CREATE SEQUENCE and identity columns take them. */
function sequenceSettings(sequence: Sequence): string {
  return [
    `INCREMENT BY ${sequence.increment} MINVALUE ${sequence.minimum}`,
    ` MAXVALUE ${sequence.maximum} START WITH ${sequence.start} CACHE ${sequence.cache}`,
    sequence.cycle ? " CYCLE" : " NO CYCLE",
  ].join("");
}

/** The sequence a `serial` column numbers its rows from, with every setting spelled out. */
export function createSequence(sequence: Sequence): string {
  return `CREATE SEQUENCE ${qualified(sequence.schema, sequence.name)} AS ${sequence.dataType} ${sequenceSettings(sequence)}`;
}

/** A `WITH (...)` clause of storage parameters, or nothing when there are none. */
export function storageParameters(options: readonly string[]): string {
  return options.length > 0 ? ` WITH (${options.join(", ")})` : "";
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
    `FOREIGN KEY ${foreignKeyColumnList(key.columns, key.period)}`,
    ` REFERENCES ${qualified(references.schema, references.table)} ${foreignKeyColumnList(references.columns, key.period)}`,
    match,
    ` ON UPDATE ${key.onUpdate.toUpperCase()} ON DELETE ${key.onDelete.toUpperCase()}`,
    key.onDeleteColumns.length > 0 ? ` ${columnList(key.onDeleteColumns)}` : "",
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
    storageParameters(index.options),
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

/** `item` with its comment left out, to compare what it does apart from what it says. */
export function uncommented<Item extends { readonly comment: Comment | null }>(item: Item): Item {
  return { ...item, comment: null };
}

/** Re-runnable: a run that dropped the index but failed before recording it finds it gone. */
export function dropIndexStatement(table: QualifiedName, index: string): string {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${qualified(table.schema, index)}`;
}
