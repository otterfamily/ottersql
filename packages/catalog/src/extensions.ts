import type { Extension } from "@electric-sql/pglite";
import { splitStatements } from "@ottersql/sql";

/** A `CREATE EXTENSION` statement of the SQL ottersql runs in PGlite. */
interface CreatedExtension {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

const createExtension =
  /^create\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"(?<quoted>[^"]+)"|(?<plain>\w+))/iv;
// PGlite names each extension's module after it, with underscores for hyphens; nothing else, so
// a name taken from SQL cannot point outside the package's contrib directory.
const moduleName = /^[0-9_a-z]+$/v;

function createdExtensions(sql: string): CreatedExtension[] {
  return splitStatements(sql).flatMap((statement) => {
    const groups = createExtension.exec(statement.text)?.groups;
    const name = groups?.["quoted"] ?? groups?.["plain"]?.toLowerCase();
    return name === undefined
      ? []
      : [{ name, start: statement.start, end: statement.start + statement.text.length }];
  });
}

function isExtension(value: unknown): value is Extension {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "setup") === "function"
  );
}

/**
 * Extensions PGlite publishes as packages of their own, which ottersql loads when the project has
 * installed them, so that nobody else downloads them.
 */
const separatePackages: ReadonlyMap<
  string,
  { readonly name: string; readonly load: () => Promise<Extension> }
> = new Map([
  [
    "vector",
    {
      name: "@electric-sql/pglite-pgvector",
      load: async () => {
        const { vector } = await import("@electric-sql/pglite-pgvector");
        return vector;
      },
    },
  ],
]);

/** The extension PGlite ships under `name`, or `null` when it ships none by that name. */
async function shippedExtension(name: string): Promise<Extension | null> {
  const separate = separatePackages.get(name);
  try {
    return await (separate === undefined ? contribExtension(name) : separate.load());
  } catch {
    return null;
  }
}

/** An extension of PGlite's own contrib directory, which throws when there is none by `name`. */
async function contribExtension(name: string): Promise<Extension | null> {
  const module = name.replaceAll("-", "_");
  if (!moduleName.test(module)) {
    return null;
  }
  const exports: unknown = await import(`@electric-sql/pglite/contrib/${module}`);
  const extension: unknown =
    typeof exports === "object" && exports !== null ? Reflect.get(exports, module) : undefined;
  return isExtension(extension) ? extension : null;
}

/**
 * The extensions the SQL texts create, split into those PGlite ships, to load when it starts, and
 * those it lacks. Loading only what is created keeps PGlite's start fast; each extension adds
 * about 60 ms.
 */
export async function extensionsFor(sqlTexts: readonly string[]): Promise<{
  readonly shipped: readonly string[];
  readonly missing: readonly string[];
}> {
  const names = [
    ...new Set(sqlTexts.flatMap((sql) => createdExtensions(sql).map(({ name }) => name))),
  ];
  const found = await Promise.all(
    names.map(async (name) => ({ name, shipped: (await shippedExtension(name)) !== null })),
  );
  return {
    shipped: found.flatMap(({ name, shipped }) => (shipped ? [name] : [])),
    missing: found.flatMap(({ name, shipped }) => (shipped ? [] : [name])),
  };
}

/** The extensions PGlite ships under `names`, keyed as `PGlite.create` takes them. */
export async function shippedExtensions(
  names: readonly string[],
): Promise<Record<string, Extension>> {
  const entries = await Promise.all(
    names.map(async (name) => [name.replaceAll("-", "_"), await shippedExtension(name)] as const),
  );
  return Object.fromEntries(
    entries.flatMap(([key, extension]) => (extension === null ? [] : [[key, extension]])),
  );
}

/**
 * `sql` with the statements that create the `missing` extensions blanked out, keeping every other
 * character where it was so that positions in errors still point into the original text.
 */
export function withoutMissing(sql: string, missing: readonly string[]): string {
  return createdExtensions(sql)
    .filter(({ name }) => missing.includes(name))
    .reduce(
      (text, { start, end }) =>
        text.slice(0, start) + text.slice(start, end).replaceAll(/[^\n]/gv, " ") + text.slice(end),
      sql,
    );
}

/** The note an error gets when extensions were skipped, which is often why the SQL failed. */
export function skippedNote(missing: readonly string[]): string {
  if (missing.length === 0) {
    return "";
  }
  const named = missing.map((name) => {
    const installable = separatePackages.get(name)?.name;
    return installable === undefined ? name : `${name} (install ${installable} to load it)`;
  });
  return `; PGlite has no extension ${named.join(", ")}, so ottersql skipped creating it`;
}
