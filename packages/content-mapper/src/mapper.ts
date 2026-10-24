import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { SchemaError } from "@ottersql/catalog";

import type { Handler } from "./json-rpc.ts";
import { DiagnosticCode } from "./render.ts";
import type { RenderedFile } from "./render.ts";
import { openQuerySession } from "./session.ts";
import type { QuerySession } from "./session.ts";

interface Project {
  readonly schemaPath: string;
  readonly schemaHash: string;
}

type Loaded = { readonly session: QuerySession } | { readonly error: string };

/**
 * TypeScript's content mapper protocol for `.sql` files. A project names its schema with the
 * `schema` option (default `schema.sql`, relative to the tsconfig); that file maps to an empty
 * module, and every other `.sql` file is typed against it. Sessions are shared by every project
 * with the same schema text and replaced when it changes.
 */
export function createMapper(): Handler {
  const projects = new Map<string, Project>();
  const sessions = new Map<string, Promise<Loaded>>();
  const methods: Readonly<Record<string, (params: unknown) => unknown>> = {
    initialize: () => ({ positionEncoding: "utf-16", diagnosticSource: "sql" }),
    openProject: async (params) => {
      const { projectHandle, configFileName, schema } = openProjectParams(params);
      const schemaPath = resolve(dirname(configFileName), schema);
      const schemaText = await readFile(schemaPath, "utf8");
      const schemaHash = createHash("sha256").update(schemaText).digest("hex");
      projects.set(projectHandle, { schemaPath, schemaHash });
      if (!sessions.has(schemaHash)) {
        sessions.set(schemaHash, load(schemaText, schemaPath));
      }
      await closeUnused(projects, sessions);
      return { configIdentity: schemaHash, watchedFiles: [schemaPath] };
    },
    transform: async (params) => {
      const { projectHandle, fileName, content } = transformParams(params);
      const project = projects.get(projectHandle);
      if (project !== undefined && resolve(fileName) === project.schemaPath) {
        return transformed({ text: "export {};\n", mappings: [], diagnostics: [] });
      }
      const loaded = await (project === undefined ? undefined : sessions.get(project.schemaHash));
      if (loaded === undefined) {
        throw new Error(`transform for unknown project ${projectHandle}`);
      }
      return transformed(
        "session" in loaded
          ? await loaded.session.renderFile(content)
          : schemaFailure(loaded.error),
      );
    },
    closeProject: async (params) => {
      projects.delete(stringField(params, "projectHandle"));
      await closeUnused(projects, sessions);
      return null;
    },
  };
  return async (method, params) => {
    const run = methods[method];
    if (run === undefined) {
      throw new Error(`unknown method ${method}`);
    }
    return await run(params);
  };
}

async function load(schemaText: string, schemaPath: string): Promise<Loaded> {
  try {
    return { session: await openQuerySession(schemaText) };
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

async function closeUnused(
  projects: ReadonlyMap<string, Project>,
  sessions: Map<string, Promise<Loaded>>,
): Promise<void> {
  const used = new Set([...projects.values()].map((project) => project.schemaHash));
  for (const [hash, loaded] of sessions) {
    if (!used.has(hash)) {
      sessions.delete(hash);
      const settled = await loaded;
      if ("session" in settled) {
        await settled.session.close();
      }
    }
  }
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
    options === undefined ? "schema.sql" : (optionalString(options, "schema") ?? "schema.sql");
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
  const field: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  return typeof field === "string" ? field : undefined;
}

function objectField(value: unknown, name: string): object | undefined {
  const field: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  return typeof field === "object" && field !== null ? field : undefined;
}
