import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { pglite } from "@ottersql/testing";
import { describe, expect, onTestFinished, test } from "vitest";

import { pgliteConnection } from "./pglite.ts";
import type { TypedQuery } from "./query.ts";
import { bundlers, OUTPUT } from "./test-bundlers.ts";

type Add = TypedQuery<{ a: number; b: number }, { sum: number }>;

const queries = "-- @name add\nselect :a::int4 + :b::int4 as sum";

/** A directory with `queries.sql` and an entry that re-exports its query, removed after the test. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-bundle-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "queries.sql"), queries);
  await writeFile(join(root, "main.js"), 'export { add } from "./queries.sql";\n');
  return root;
}

function isAdd(value: unknown): value is Add {
  return typeof value === "function" && "one" in value;
}

async function bundledAdd(root: string): Promise<Add> {
  const module: unknown = await import(pathToFileURL(join(root, "dist", OUTPUT)).href);
  const add = typeof module === "object" && module !== null && "add" in module ? module.add : null;
  if (!isAdd(add)) {
    throw new TypeError("the bundle exports no query named add");
  }
  return add;
}

describe.each(bundlers)("bundling .sql files with $name", ({ bundle }) => {
  test("gives a module that runs each query with named parameters and decoded rows", async () => {
    const root = await project();
    await bundle(root);
    const add = await bundledAdd(root);
    const connection = pgliteConnection(await pglite());
    await expect(add.one(connection, { a: 2, b: 3 })).resolves.toStrictEqual({ sum: 5 });
  });
});
