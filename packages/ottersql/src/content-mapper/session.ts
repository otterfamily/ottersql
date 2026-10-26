import type { PGlite } from "@electric-sql/pglite";

import { readRelations, readTypeRefs } from "../catalog/by-oid.ts";
import type { Relation } from "../catalog/by-oid.ts";
import { openSchema } from "../catalog/index.ts";
import type { Catalog, TypeRef } from "../catalog/index.ts";
import { pgliteConnection } from "../sql/pglite.ts";
import { fileOffset, offsetOfPosition, readQueryFile } from "../sql/query-file.ts";
import type { Query, Span } from "../sql/query-file.ts";
import { readBuiltInFacts } from "./built-in-functions.ts";
import type { BuiltInFacts } from "./built-in-functions.ts";
import { relationFacts, relationOids } from "./column-facts.ts";
import { NODE_FORMAT_MAJOR, statementNullability } from "./nullability.ts";
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
 * `ottersql/catalog` when Postgres rejects the schema. `cache` keeps the database the schema
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
    catalog: schema.catalog,
    builtIns: await readBuiltInFacts(db),
    statements: new Map(),
    types: new Map(),
    relations: new Map(),
  };
  // The content mapper answers requests concurrently, but a statement's Parse and Describe and the
  // lookups after it must not interleave with another's on the one connection; closing waits too.
  const serially = queue();
  return {
    describeFile: async (content) => serially(async () => describeFile(context, content)),
    renderFile: async (content) =>
      renderFile(await serially(async () => describeFile(context, content)), context.catalog),
    close: async () => serially(async () => schema.close()),
  };
}

/** Runs each task once the tasks given before it have settled. */
function queue(): <Result>(task: () => Promise<Result>) => Promise<Result> {
  let previous: Promise<null> = Promise.resolve(null);
  return async (task) => {
    const waited = previous;
    const { promise: settled, resolve } = Promise.withResolvers<null>();
    previous = settled;
    try {
      await waited;
      return await task();
    } finally {
      resolve(null);
    }
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
  // A computed column reports table oid 0, which no lookup can find.
  const tableOids = fields.map((column) => column.tableID).filter((oid) => oid !== 0);
  await lookUp(context, {
    types: [...parameterTypes, ...fields.map((column) => column.dataTypeID)],
    relations: [...tableOids, ...relationOids(tree)],
  });
  const { types, relations } = context;
  const facts = { ...relationFacts(context.catalog, relations), ...context.builtIns };
  const proven = tree === null ? null : statementNullability(tree, facts);
  return {
    kind: "described",
    parameterTypes: parameterTypes.map((oid) => knownType(types.get(oid), oid)),
    nonNullParameters: proven?.nonNullParameters ?? new Set(),
    columns: fields.map((column, index) => ({
      name: column.name,
      type: knownType(types.get(column.dataTypeID), column.dataTypeID),
      nullable: proven?.columns[index] ?? true,
      origin: origin(relations.get(column.tableID), column.columnID),
    })),
  };
}

/** Reads the types and relations the session has not looked up yet into its maps. */
async function lookUp(
  context: Context,
  oids: { readonly types: readonly number[]; readonly relations: readonly number[] },
): Promise<void> {
  const types = missing(context.types, oids.types);
  const relations = missing(context.relations, oids.relations);
  if (types.length === 0 && relations.length === 0) {
    return;
  }
  // Postgres would print each lookup's own parse tree too, which takes longer than the lookup.
  await context.db.exec("set debug_print_rewritten = off");
  // The same database always gives the same connection, so this opens nothing.
  const connection = pgliteConnection(context.db);
  try {
    store(context.types, types.length === 0 ? [] : await readTypeRefs(connection, types));
    store(
      context.relations,
      relations.length === 0 ? [] : await readRelations(connection, relations),
    );
  } finally {
    await context.db.exec("set debug_print_rewritten = on");
  }
}

function missing(known: ReadonlyMap<number, unknown>, oids: readonly number[]): number[] {
  return [...new Set(oids)].filter((oid) => !known.has(oid));
}

function store<Value>(known: Map<number, Value>, read: Iterable<readonly [number, Value]>): void {
  for (const [oid, value] of read) {
    known.set(oid, value);
  }
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
