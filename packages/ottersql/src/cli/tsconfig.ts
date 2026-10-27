import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { lineAndColumn } from "../sql/internal.ts";
import { parseJsonc } from "./jsonc.ts";
import { CommandError } from "./outcome.ts";

/** The content mapper package name a tsconfig gives ottersql. */
export const CONTENT_MAPPER = "ottersql";

/**
 * What ottersql reads from a tsconfig, following `extends` as TypeScript does: a field comes from
 * the nearest file that sets it, and its relative paths are relative to that file.
 */
export interface Tsconfig {
  /** The `schema` option of the ottersql content mapper, as an absolute path; `null` when unset. */
  readonly schema: string | null;
  /** `exclude`, as absolute glob patterns; `null` when no file sets it. */
  readonly exclude: readonly string[] | null;
  /** `compilerOptions.outDir`, as an absolute path; `null` when unset. */
  readonly outDir: string | null;
}

/** The fields one file sets: `undefined` where it leaves them to what it extends. */
type Own = { readonly [Field in keyof Tsconfig]: Tsconfig[Field] | undefined };

/** Reads the tsconfig at `file` and every file it extends. `cwd` is where paths in errors start. */
export async function readTsconfig(file: string, cwd: string): Promise<Tsconfig> {
  const merged = await readChain(file, { cwd, configDir: dirname(file) }, new Set());
  return {
    schema: merged.schema ?? null,
    exclude: merged.exclude ?? null,
    outDir: merged.outDir ?? null,
  };
}

/** Where the reading started: `cwd` for paths in errors, `configDir` for `${configDir}`. */
interface Start {
  readonly cwd: string;
  readonly configDir: string;
}

async function readChain(file: string, start: Start, seen: ReadonlySet<string>): Promise<Own> {
  const { cwd } = start;
  if (seen.has(file)) {
    throw invalid(file, cwd, "extends itself");
  }
  const config = await readConfig(file, cwd);
  const bases = await Promise.all(
    extendsOf(config).map(async (spec) =>
      readChain(resolveExtends(spec, file, cwd), start, new Set([...seen, file])),
    ),
  );
  // Later bases override earlier ones, and the file itself overrides them all.
  let merged: Own = { schema: undefined, exclude: undefined, outDir: undefined };
  for (const own of [...bases, ownFields(config, file, start.configDir)]) {
    merged = {
      schema: own.schema === undefined ? merged.schema : own.schema,
      exclude: own.exclude ?? merged.exclude,
      outDir: own.outDir ?? merged.outDir,
    };
  }
  return merged;
}

async function readConfig(file: string, cwd: string): Promise<unknown> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) {
    throw new CommandError({
      kind: "invalid",
      code: "project.tsconfig_unreadable",
      why: `Cannot read ${relative(cwd, file)}`,
      fix: "Pass --project the path of a tsconfig, or fix the extends that names it",
      where: { file: relative(cwd, file) },
    });
  }
  const parsed = parseJsonc(text);
  if (!("value" in parsed)) {
    throw new CommandError({
      kind: "invalid",
      code: "project.tsconfig_invalid",
      why: `${relative(cwd, file)} is not valid JSON: ${parsed.error}`,
      fix: "Fix the tsconfig",
      where: {
        file: relative(cwd, file),
        ...(parsed.offset === null ? {} : { line: lineAndColumn(text, parsed.offset).line }),
      },
    });
  }
  return parsed.value;
}

const CONFIG_DIR = `\${configDir}`;

function ownFields(config: unknown, file: string, configDir: string): Own {
  const directory = dirname(file);
  // As TypeScript reads them: relative to the file that sets them, but ${configDir} stands for the
  // directory of the tsconfig the reading started from, so a shared base can name the project's.
  const path = (value: string): string =>
    value.startsWith(CONFIG_DIR)
      ? resolve(configDir, `.${value.slice(CONFIG_DIR.length)}`)
      : resolve(directory, value);
  const exclude = strings(field(config, "exclude"));
  const outDir = field(field(config, "compilerOptions"), "outDir");
  return {
    schema: schemaOf(config, directory),
    exclude: exclude?.map((pattern) => path(pattern)),
    outDir: typeof outDir === "string" ? path(outDir) : undefined,
  };
}

/**
 * The schema option the file sets: `undefined` when it sets no contentMappers, and `null` when it
 * does without one for ottersql, since its list replaces the one it extends.
 */
function schemaOf(config: unknown, directory: string): string | null | undefined {
  const mappers: unknown = field(config, "contentMappers");
  if (!Array.isArray(mappers)) {
    return undefined;
  }
  const entries: readonly unknown[] = mappers;
  const mapper = entries.find((entry) => field(entry, "package") === CONTENT_MAPPER);
  const schema = field(field(mapper, "options"), "schema");
  return typeof schema === "string" ? resolve(directory, schema) : null;
}

/** The strings of a list, or `undefined` when `value` is not one. */
function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: readonly unknown[] = value;
  return items.filter((item) => typeof item === "string");
}

function extendsOf(config: unknown): readonly string[] {
  const value = field(config, "extends");
  return typeof value === "string" ? [value] : (strings(value) ?? []);
}

/** Where `spec` in the extends of `file` points: a path, or a package as Node resolves it. */
function resolveExtends(spec: string, file: string, cwd: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const path = resolve(dirname(file), spec);
    return path.endsWith(".json") ? path : `${path}.json`;
  }
  const require = createRequire(file);
  for (const candidate of [spec, `${spec}.json`, `${spec}/tsconfig.json`]) {
    try {
      return require.resolve(candidate);
    } catch {
      // Tried in the order TypeScript tries them.
    }
  }
  throw invalid(file, cwd, `extends ${spec}, which cannot be found`);
}

function invalid(file: string, cwd: string, why: string): CommandError {
  return new CommandError({
    kind: "invalid",
    code: "project.tsconfig_invalid",
    why: `${relative(cwd, file)} ${why}`,
    fix: "Fix the tsconfig's extends",
    where: { file: relative(cwd, file) },
  });
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}
