import type { PGlite } from "@electric-sql/pglite";
import { findTable, openSchema, readRelations, readTypeRefs } from "@ottersql/catalog";
import type { Catalog, Relation, TypeRef } from "@ottersql/catalog";
import type { Connection } from "@ottersql/sql";
import { pgliteConnection } from "@ottersql/sql/pglite";
import { fileOffset, offsetOfPosition, readQueryFile } from "@ottersql/sql/tooling";
import type { Query, Span } from "@ottersql/sql/tooling";

import { readBuiltInFacts } from "./built-in-functions.ts";
import type { BuiltInFacts } from "./built-in-functions.ts";
import { nodesOfType, scalar } from "./node-tree.ts";
import type { NodeObject } from "./node-tree.ts";
import { NODE_FORMAT_MAJOR, nonNullParameters, nullableColumns } from "./nullability.ts";
import { renderFile } from "./render.ts";
import type { RenderedFile } from "./render.ts";
import { describeStatement } from "./statement.ts";
import type { PostgresError, StatementDescription } from "./statement.ts";

export interface QuerySession {
  /** Describes every query of a `.sql` file against the schema the session was opened with. */
  readonly describeFile: (content: string) => Promise<DescribedFile>;
  /** The TypeScript module a `.sql` file stands for, with its diagnostics. */
  readonly renderFile: (content: string) => Promise<RenderedFile>;
  readonly close: () => Promise<void>;
}

export interface DescribedFile {
  /** The queries Postgres accepted; a query it rejected appears only in `problems`. */
  readonly queries: readonly DescribedQuery[];
  readonly problems: readonly Problem[];
}

export interface Problem {
  /** Whether the `.sql` file itself is malformed, or Postgres rejected a query in it. */
  readonly source: "queryFile" | "postgres";
  readonly message: string;
  readonly span: Span;
}

export interface DescribedQuery {
  readonly query: Query;
  readonly name: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly type: TypeRef;
    /** `false` only when the statement writes it straight into a NOT NULL column. */
    readonly nullable: boolean;
  }[];
  readonly columns: readonly DescribedColumn[];
}

export interface DescribedColumn {
  readonly name: string;
  readonly type: TypeRef;
  /** `false` only when ADR 0009's rules prove the column is never null. */
  readonly nullable: boolean;
  /** The table or view column the value is read from, when Postgres reports one. */
  readonly origin: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  } | null;
}

/** What a statement's SQL text alone determines, while the session's schema is loaded. */
interface DescribedStatement {
  readonly kind: "described";
  readonly parameterTypes: readonly TypeRef[];
  /** The `$n` numbers of parameters that may not be null. */
  readonly nonNullParameters: ReadonlySet<number>;
  readonly columns: readonly DescribedColumn[];
}

interface Context {
  readonly db: PGlite;
  /** The same database as `db`, for the catalog lookups that read it as any driver would. */
  readonly connection: Connection;
  readonly catalog: Catalog;
  readonly builtIns: BuiltInFacts;
  /**
   * The finished description per SQL text: an editor asks for the whole file on every keystroke,
   * and usually only one query in it has changed.
   */
  readonly statements: Map<string, DescribedStatement | PostgresError>;
  /** Oids do not change while a session's schema is loaded, so lookups are kept. */
  readonly types: Map<number, TypeRef>;
  readonly relations: Map<number, Relation>;
}

/**
 * Opens a session that describes queries against `schemaSql`. Rejects with a `SchemaError` from
 * `@ottersql/catalog` when Postgres rejects the schema. `cache` keeps the database the schema
 * leaves for the next session with the same schema (`openSchema`).
 */
export async function openQuerySession(
  schemaSql: string,
  { cache = false }: { readonly cache?: boolean } = {},
): Promise<QuerySession> {
  const schema = await openSchema(schemaSql, { cache });
  const { major } = schema.catalog.capabilities.version;
  if (major !== NODE_FORMAT_MAJOR) {
    await schema.close();
    throw new Error(
      `ottersql reads query trees of Postgres ${String(NODE_FORMAT_MAJOR)}, but PGlite runs Postgres ${String(major)}`,
    );
  }
  const db = schema.database;
  // Postgres sends the analyzed tree of every statement it parses back as a LOG notice (ADR 0009).
  await db.exec(
    "set debug_print_rewritten = on; set debug_pretty_print = off; set client_min_messages = log;",
  );
  const context: Context = {
    db,
    connection: pgliteConnection(db),
    catalog: schema.catalog,
    builtIns: await readBuiltInFacts(db),
    statements: new Map(),
    types: new Map(),
    relations: new Map(),
  };
  return {
    describeFile: async (content) => describeFile(context, content),
    renderFile: async (content) =>
      renderFile(await describeFile(context, content), context.catalog),
    close: async () => schema.close(),
  };
}

async function describeFile(context: Context, content: string): Promise<DescribedFile> {
  const file = readQueryFile(content);
  const problems: Problem[] = file.problems.map((problem) => ({ source: "queryFile", ...problem }));
  const queries: DescribedQuery[] = [];
  for (const query of file.queries) {
    const statement = await describeCached(context, query.sql);
    if (statement.kind === "error") {
      problems.push({
        source: "postgres",
        message: statement.message,
        span: errorSpan(query, statement),
      });
    } else {
      queries.push({
        query,
        name: query.name,
        parameters: query.parameters.map((parameter, index) => ({
          name: parameter.name,
          type: knownType(statement.parameterTypes[index]),
          nullable: !statement.nonNullParameters.has(index + 1),
        })),
        columns: statement.columns,
      });
    }
  }
  return { queries, problems };
}

async function analyze(
  context: Context,
  description: StatementDescription,
): Promise<DescribedStatement> {
  const { fields, parameterTypes, tree } = description;
  const types = await cached(
    context.types,
    [...parameterTypes, ...fields.map((column) => column.dataTypeID)],
    async (oids) => readTypeRefs(context.connection, oids),
  );
  // A computed column reports table oid 0, which no lookup can find.
  const tableOids = fields.map((column) => column.tableID).filter((oid) => oid !== 0);
  const relations = await cached(
    context.relations,
    [...tableOids, ...relationOids(tree)],
    async (oids) => readRelations(context.connection, oids),
  );
  const facts = {
    isNotNullColumn: (relationOid: number, attnum: number) =>
      isNotNullColumn(context.catalog, relations.get(relationOid), attnum),
    ...context.builtIns,
  };
  const nullable = tree === null ? [] : nullableColumns(tree, facts);
  return {
    kind: "described",
    parameterTypes: parameterTypes.map((oid) => knownType(types.get(oid), oid)),
    nonNullParameters: tree === null ? new Set() : nonNullParameters(tree, facts),
    columns: fields.map((column, index) => ({
      name: column.name,
      type: knownType(types.get(column.dataTypeID), column.dataTypeID),
      nullable: nullable[index] ?? true,
      origin: origin(relations.get(column.tableID), column.columnID),
    })),
  };
}

/** Reads only the oids not yet in `cache`, and adds them to it. */
async function cached<Value>(
  cache: Map<number, Value>,
  oids: readonly number[],
  read: (missing: readonly number[]) => Promise<ReadonlyMap<number, Value>>,
): Promise<ReadonlyMap<number, Value>> {
  const missing = [...new Set(oids)].filter((oid) => !cache.has(oid));
  if (missing.length > 0) {
    for (const [oid, value] of await read(missing)) {
      cache.set(oid, value);
    }
  }
  return cache;
}

// Bounds the per-session cache; old entries are mostly SQL from earlier edits.
const MAX_CACHED_STATEMENTS = 2000;

async function describeCached(
  context: Context,
  sql: string,
): Promise<DescribedStatement | PostgresError> {
  const known = context.statements.get(sql);
  if (known !== undefined) {
    return known;
  }
  const description = await describeStatement(context.db, sql);
  const described =
    description.kind === "error" ? description : await analyze(context, description);
  context.statements.set(sql, described);
  const [oldest] = context.statements.keys();
  if (context.statements.size > MAX_CACHED_STATEMENTS && oldest !== undefined) {
    context.statements.delete(oldest);
  }
  return described;
}

/** Every table, view and other relation the analyzed tree reads from, however deeply nested. */
function relationOids(tree: NodeObject | null): number[] {
  return nodesOfType(tree ?? undefined, "RANGETBLENTRY").flatMap((entry) => {
    const relid = scalar(entry, "relid");
    return relid === undefined ? [] : [Number(relid)];
  });
}

function isNotNullColumn(
  catalog: Catalog,
  relation: Relation | undefined,
  attnum: number,
): boolean {
  if (relation === undefined) {
    return false;
  }
  const name = relation.columns.get(attnum);
  const table = findTable(catalog, relation.schema, relation.name);
  return (
    table !== undefined &&
    (table.columns.some((column) => column.name === name && column.notNull) ||
      table.checks.some((check) => name !== undefined && check.notNullColumns.includes(name)))
  );
}

function origin(relation: Relation | undefined, attnum: number): DescribedColumn["origin"] {
  const column = relation?.columns.get(attnum);
  return relation === undefined || column === undefined
    ? null
    : { schema: relation.schema, table: relation.name, column };
}

function knownType(type: TypeRef | undefined, oid?: number): TypeRef {
  if (type === undefined) {
    throw new Error(`Postgres reported type oid ${String(oid)}, which pg_type does not list`);
  }
  return type;
}

function errorSpan(query: Query, error: PostgresError): Span {
  if (error.position === null) {
    return query.nameSpan;
  }
  return { start: fileOffset(query, offsetOfPosition(query.sql, error.position)), length: 0 };
}
