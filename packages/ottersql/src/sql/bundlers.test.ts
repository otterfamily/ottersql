import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { pglite } from "@ottersql/testing";
import { describe, expect, onTestFinished, test } from "vitest";

import { pgliteConnection } from "./pglite.ts";
import type { TypedQuery } from "./query.ts";
import { bundlers, OUTPUT } from "./test-bundlers.ts";
import { json } from "./values.ts";
import type { Json } from "./values.ts";

type Add = TypedQuery<{ a: number; b: number }, { sum: number }>;
type Echo = TypedQuery<{ doc: Json }, { doc: unknown }>;

const queries =
  "-- @name add\nselect :a::int4 + :b::int4 as sum;\n-- @name echo\nselect :doc::jsonb as doc";

/** A directory with `queries.sql` and an entry that re-exports its queries, removed after the test. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-bundle-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "queries.sql"), queries);
  await writeFile(join(root, "main.js"), 'export { add, echo } from "./queries.sql";\n');
  return root;
}

/** The query `name` the bundle in `root` exports, checked with `is`. */
async function bundledQuery<Query>(
  root: string,
  name: string,
  is: (value: unknown) => value is Query,
): Promise<Query> {
  const module: unknown = await import(pathToFileURL(join(root, "dist", OUTPUT)).href);
  const query: unknown =
    typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
  if (!is(query)) {
    throw new TypeError(`the bundle exports no query named ${name}`);
  }
  return query;
}

function isAdd(value: unknown): value is Add {
  return typeof value === "function" && "one" in value;
}

function isEcho(value: unknown): value is Echo {
  return typeof value === "function" && "one" in value;
}

describe.each(bundlers)("bundling .sql files with $name", ({ bundle }) => {
  test("gives a module that runs each query with named parameters and decoded rows", async () => {
    const root = await project();
    await bundle(root);
    const add = await bundledQuery(root, "add", isAdd);
    const connection = pgliteConnection(await pglite());
    await expect(add.one(connection, { a: 2, b: 3 })).resolves.toStrictEqual({ sum: 5 });
  });

  test("takes json() from the application's copy of ottersql, not the bundle's", async () => {
    const root = await project();
    await bundle(root);
    const echo = await bundledQuery(root, "echo", isEcho);
    const connection = pgliteConnection(await pglite());
    await expect(echo.one(connection, { doc: json({ a: [1] }) })).resolves.toStrictEqual({
      doc: { a: [1] },
    });
  });
});
