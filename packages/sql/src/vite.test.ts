import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { pglite } from "@ottersql/testing";
import { build } from "vite";
import { describe, expect, onTestFinished, test } from "vitest";

import { pgliteConnection } from "./pglite.ts";
import type { TypedQuery } from "./query.ts";
import { ottersql } from "./vite.ts";

const queries = "-- @name add\nselect :a::int4 + :b::int4 as sum";

/** A directory with `queries.sql`, removed when the test finishes. */
async function project(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-vite-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "queries.sql"), content);
  return root;
}

function isQuery(value: unknown): value is TypedQuery<{ a: number; b: number }, { sum: number }> {
  return typeof value === "function" && "one" in value;
}

/** The `add` export of a module, checked to be a query. */
function addOf(module: unknown): TypedQuery<{ a: number; b: number }, { sum: number }> {
  const add = typeof module === "object" && module !== null && "add" in module ? module.add : null;
  if (!isQuery(add)) {
    throw new TypeError("the module exports no query named add");
  }
  return add;
}

describe("importing .sql files through the Vite plugin", () => {
  test("in Vitest, each query runs with named parameters and decoded rows", async () => {
    const root = await project(queries);
    const add = addOf(await import(join(root, "queries.sql")));
    const connection = pgliteConnection(await pglite());
    await expect(add.one(connection, { a: 1, b: 2 })).resolves.toStrictEqual({
      sum: 3,
    });
  });

  test("in Vitest, a file with problems fails to import, naming where each one is", async () => {
    const root = await project("-- @name add\nselect $1 as sum");
    await expect(import(join(root, "queries.sql"))).rejects.toThrow(
      "queries.sql:2:8 Use :name parameters instead of $1",
    );
  });

  test("a Vite build bundles the queries into a module that runs them", async () => {
    const root = await project(queries);
    await writeFile(join(root, "main.js"), 'export { add } from "./queries.sql";\n');
    await build({
      root,
      logLevel: "silent",
      configFile: false,
      plugins: [ottersql()],
      build: { ssr: "main.js", outDir: "dist" },
    });
    const add = addOf(await import(pathToFileURL(join(root, "dist", "main.mjs")).href));
    const connection = pgliteConnection(await pglite());
    await expect(add.one(connection, { a: 2, b: 3 })).resolves.toStrictEqual({
      sum: 5,
    });
  });
});
