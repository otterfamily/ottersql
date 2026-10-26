import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SchemaError } from "../catalog/index.ts";
import { holdsQueries } from "../sql/query-file.ts";
import { METHOD_NOT_FOUND, RpcError } from "./json-rpc.ts";
import { DiagnosticCode } from "./render.ts";
import type { RenderedFile } from "./render.ts";
import { openQuerySession } from "./session.ts";
import type { QuerySession } from "./session.ts";

interface Project {
  readonly schemaPath: string;
  readonly schemaHash: string;
}

/** Where a project keeps its schema when its tsconfig gives no `schema` option, relative to the tsconfig. */
export const defaultSchemaPath = "db/schema.sql";

/** Where a project keeps its migrations: the `migrations` directory next to its schema (#27). */
export function migrationsDirectory(schemaPath: string): string {
  return join(dirname(schemaPath), "migrations");
}

/** Answers one request of TypeScript's content mapper protocol. */
export type Handler = (method: string, params: unknown) => Promise<unknown>;

type Loaded = { readonly session: QuerySession } | { readonly error: string };

/**
 * TypeScript's content mapper protocol for `.sql` files. A project names its schema with the
 * `schema` option (default `defaultSchemaPath`, relative to the tsconfig); that file and the
 * migrations next to it map to empty modules, and every other `.sql` file is typed against it. Sessions are shared by every project
 * with the same schema text and replaced when it changes.
 */
export function createMapper(): Handler {
  const state: State = { projects: new Map(), sessions: new Map() };
  const methods: Readonly<Record<string, (params: unknown) => unknown>> = {
    initialize: () => ({ positionEncoding: "utf-16", diagnosticSource: "sql" }),
    openProject: async (params) => openProject(state, params),
    transform: async (params) => transform(state, params),
    closeProject: async (params) => {
      state.projects.delete(stringField(params, "projectHandle"));
      await closeUnused(state);
      return null;
    },
  };
  return async (method, params) => {
    const run = methods[method];
    if (run === undefined) {
      throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
    }
    return await run(params);
  };
}

/** Open projects by handle, and the sessions they use by schema text hash. */
interface State {
  readonly projects: Map<string, Project>;
  readonly sessions: Map<string, Promise<Loaded>>;
}

async function openProject(state: State, params: unknown): Promise<object> {
  const { projectHandle, configFileName, schema } = openProjectParams(params);
  const schemaPath = resolve(dirname(configFileName), schema);
  const schemaText = await readFile(schemaPath, "utf8").catch(() => null);
  const schemaHash = createHash("sha256")
    .update(schemaText ?? `unreadable ${schemaPath}`)
    .digest("hex");
  state.projects.set(projectHandle, { schemaPath, schemaHash });
  // Closing the replaced schema's session first keeps one PGlite in memory instead of two.
  await closeUnused(state);
  if (!state.sessions.has(schemaHash)) {
    state.sessions.set(
      schemaHash,
      schemaText === null
        ? Promise.resolve({ error: `${schemaPath}: cannot be read` })
        : load(schemaText, schemaPath),
    );
  }
  await state.sessions.get(schemaHash);
  return { configIdentity: schemaHash, watchedFiles: [schemaPath] };
}

async function transform(state: State, params: unknown): Promise<object> {
  const { projectHandle, fileName, content } = transformParams(params);
  const project = state.projects.get(projectHandle);
  if (project !== undefined && !isQueryFile(project.schemaPath, resolve(fileName), content)) {
    return transformed({ text: "export {};\n", mappings: [], diagnostics: [] });
  }
  const loaded = await (project === undefined ? undefined : state.sessions.get(project.schemaHash));
  if (loaded === undefined) {
    throw new Error(`transform for unknown project ${projectHandle}`);
  }
  return transformed(
    "session" in loaded ? await loaded.session.renderFile(content) : schemaFailure(loaded.error),
  );
}

/**
 * Whether `file` holds queries to type: not the schema, not a migration, and with `-- @name`
 * queries, unlike the `.sql` files other tools keep next to it. Both the content mapper and
 * `ottersql types` go by it.
 */
export function isQueryFile(schemaPath: string, file: string, content: string): boolean {
  return (
    file !== schemaPath &&
    dirname(file) !== migrationsDirectory(schemaPath) &&
    holdsQueries(content)
  );
}

async function load(schemaText: string, schemaPath: string): Promise<Loaded> {
  try {
    // Each tsc run starts a new content mapper, so an unchanged schema is restored, not rerun.
    return { session: await openQuerySession(schemaText, { cache: true }) };
  } catch (error) {
    if (!(error instanceof SchemaError)) {
      throw error;
    }
    const at =
      error.position === null
        ? ""
        : `:${String(error.position.line)}:${String(error.position.column)}`;
    return { error: `${schemaPath}${at}: ${error.message}` };
  }
}

/** Closes the sessions no open project uses; one that failed to load has nothing to close. */
async function closeUnused(state: State): Promise<void> {
  const used = new Set([...state.projects.values()].map((project) => project.schemaHash));
  const unused = [...state.sessions].filter(([hash]) => !used.has(hash));
  for (const [hash] of unused) {
    state.sessions.delete(hash);
  }
  await Promise.allSettled(
    unused.map(async ([, loaded]) => {
      const settled = await loaded;
      if ("session" in settled) {
        await settled.session.close();
      }
    }),
  );
}

function schemaFailure(error: string): RenderedFile {
  return {
    text: "export {};\n",
    mappings: [],
    diagnostics: [{ messageText: error, start: 0, length: 0, code: DiagnosticCode.schema }],
  };
}

function transformed(file: RenderedFile): object {
  return {
    text: file.text,
    extension: ".ts",
    mappings: file.mappings,
    diagnostics: file.diagnostics,
  };
}

function openProjectParams(params: unknown): {
  readonly projectHandle: string;
  readonly configFileName: string;
  readonly schema: string;
} {
  const options = objectField(params, "options");
  const schema =
    (options === undefined ? undefined : optionalString(options, "schema")) ?? defaultSchemaPath;
  return {
    projectHandle: stringField(params, "projectHandle"),
    configFileName: stringField(params, "configFileName"),
    schema,
  };
}

function transformParams(params: unknown): {
  readonly projectHandle: string;
  readonly fileName: string;
  readonly content: string;
} {
  return {
    projectHandle: stringField(params, "projectHandle"),
    fileName: stringField(params, "fileName"),
    content: stringField(params, "content"),
  };
}

function stringField(value: unknown, name: string): string {
  const field = optionalString(value, name);
  if (field === undefined) {
    throw new TypeError(`expected a string ${name}`);
  }
  return field;
}

function optionalString(value: unknown, name: string): string | undefined {
  const field = property(value, name);
  return typeof field === "string" ? field : undefined;
}

function objectField(value: unknown, name: string): object | undefined {
  const field = property(value, name);
  return typeof field === "object" && field !== null ? field : undefined;
}

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}
