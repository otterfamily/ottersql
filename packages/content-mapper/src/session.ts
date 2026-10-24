import type { PGlite } from "@electric-sql/pglite";
import { openSchema, readRelations, readTypeRefs } from "@ottersql/catalog";
import type { Catalog, Relation, TypeRef } from "@ottersql/catalog";
import { fileOffset, readQueryFile } from "@ottersql/sql";
import type { Query, Span } from "@ottersql/sql";

import { readBuiltInFacts } from "./built-in-functions.ts";
import type { BuiltInFacts } from "./built-in-functions.ts";
import { field, isNode, list, scalar } from "./node-tree.ts";
import type { NodeObject } from "./node-tree.ts";
import { nullableColumns } from "./nullability.ts";
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
  readonly parameters: readonly { readonly name: string; readonly type: TypeRef }[];
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

interface Context {
  readonly db: PGlite;
  readonly catalog: Catalog;
  readonly builtIns: BuiltInFacts;
  /** Oids do not change while a session's schema is loaded, so lookups are kept. */
  readonly types: Map<number, TypeRef>;
  readonly relations: Map<number, Relation>;
}

/**
 * Opens a session that describes queries against `schemaSql`. Rejects with a `SchemaError` from
 * `@ottersql/catalog` when Postgres rejects the schema.
 */
export async function openQuerySession(schemaSql: string): Promise<QuerySession> {
  const schema = await openSchema(schemaSql);
  const db = schema.database;
  // Postgres sends the analyzed tree of every statement it parses back as a LOG notice (ADR 0009).
  await db.exec(
    "set debug_print_rewritten = on; set debug_pretty_print = off; set client_min_messages = log;",
  );
  const context: Context = {
    db,
    catalog: schema.catalog,
    builtIns: await readBuiltInFacts(db),
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
    const result = await describeStatement(context.db, query.sql);
    if (result.kind === "error") {
      problems.push({
        source: "postgres",
        message: result.message,
        span: errorSpan(query, result),
      });
    } else {
      queries.push(await describeQuery(context, query, result));
    }
  }
  return { queries, problems };
}

async function describeQuery(
  context: Context,
  query: Query,
  description: StatementDescription,
): Promise<DescribedQuery> {
  const { fields, parameterTypes, tree } = description;
  const types = await cached(
    context.types,
    [...parameterTypes, ...fields.map((column) => column.dataTypeID)],
    async (oids) => readTypeRefs(context.db, oids),
  );
  const relations = await cached(
    context.relations,
    [...fields.map((column) => column.tableID), ...relationOids(tree)],
    async (oids) => readRelations(context.db, oids),
  );
  const nullable =
    tree === null
      ? []
      : nullableColumns(tree, {
          isNotNullColumn: (relationOid, attnum) =>
            isNotNullColumn(context.catalog, relations.get(relationOid), attnum),
          ...context.builtIns,
        });
  return {
    query,
    name: query.name,
    parameters: query.parameters.map((parameter, index) => ({
      name: parameter.name,
      type: knownType(types, parameterTypes[index]),
    })),
    columns: fields.map((column, index) => ({
      name: column.name,
      type: knownType(types, column.dataTypeID),
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

function relationOids(tree: NodeObject | null): number[] {
  return list(tree === null ? undefined : field(tree, "rtable")).flatMap((entry) => {
    const relid = isNode(entry, "RANGETBLENTRY") ? scalar(entry, "relid") : undefined;
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
  const table = catalog.tables.find(
    (candidate) => candidate.schema === relation.schema && candidate.name === relation.name,
  );
  return table?.columns.find((column) => column.name === name)?.notNull ?? false;
}

function origin(relation: Relation | undefined, attnum: number): DescribedColumn["origin"] {
  const column = relation?.columns.get(attnum);
  return relation === undefined || column === undefined
    ? null
    : { schema: relation.schema, table: relation.name, column };
}

function knownType(types: ReadonlyMap<number, TypeRef>, oid: number | undefined): TypeRef {
  const type = oid === undefined ? undefined : types.get(oid);
  if (type === undefined) {
    throw new Error(`Postgres reported type oid ${String(oid)}, which pg_type does not list`);
  }
  return type;
}

/** Postgres counts the error position in characters (code points) of the SQL sent, from 1. */
function errorSpan(query: Query, error: PostgresError): Span {
  if (error.position === null) {
    return query.nameSpan;
  }
  const sqlOffset = query.sql[Symbol.iterator]()
    .take(error.position - 1)
    .toArray()
    .join("").length;
  return { start: fileOffset(query, sqlOffset), length: 0 };
}
