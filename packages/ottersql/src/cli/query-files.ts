import { glob, readFile } from "node:fs/promises";
import { basename, join, matchesGlob, relative } from "node:path";

import { declarationFileName, isGeneratedDeclarationFile } from "../content-mapper/index.ts";
import { isQueryFile } from "../content-mapper/internal.ts";
import type { Layout } from "./project.ts";

/** Directories that hold no query files of the project. */
function skipped(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/**
 * The project's query files: the `.sql` files with `-- @name` queries, as the content mapper
 * decides, outside what the tsconfig excludes and its outDir.
 */
export async function queryFiles(layout: Layout): Promise<string[]> {
  const found: string[] = [];
  for await (const path of glob("**/*.sql", {
    cwd: layout.projectDirectory,
    exclude: (name) => skipped(basename(name)),
  })) {
    const file = join(layout.projectDirectory, path);
    if (
      !isExcluded(layout, file) &&
      isQueryFile(layout.schemaFile, file, await readFile(file, "utf8"))
    ) {
      found.push(file);
    }
  }
  return found.toSorted();
}

/** Whether the tsconfig leaves `file` out, as its exclude patterns or its outDir do. */
function isExcluded({ excluded }: Layout, file: string): boolean {
  const { patterns, outDir } = excluded;
  const inOutDir = outDir !== null && !relative(outDir, file).startsWith("..");
  return (
    inOutDir ||
    patterns.some((pattern) => matchesGlob(file, pattern) || matchesGlob(file, join(pattern, "**")))
  );
}

/** Declaration files ottersql wrote whose query file is gone. */
export async function orphanedDeclarationFiles(
  layout: Layout,
  queries: readonly string[],
): Promise<string[]> {
  const expected = new Set(queries.map((query) => declarationFileName(query)));
  const found: string[] = [];
  for await (const path of glob("**/*.d.sql.ts", {
    cwd: layout.projectDirectory,
    exclude: (name) => skipped(basename(name)),
  })) {
    const file = join(layout.projectDirectory, path);
    if (!expected.has(file) && isGeneratedDeclarationFile(await readFile(file, "utf8"))) {
      found.push(file);
    }
  }
  return found.toSorted();
}
