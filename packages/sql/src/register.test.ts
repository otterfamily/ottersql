import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, test } from "vitest";

const register = import.meta.resolve("./register.ts");
const pglite = import.meta.resolve("@electric-sql/pglite");
const pgliteConnection = import.meta.resolve("./pglite.ts");

/** Runs `app.mjs` next to `queries.sql` in Node with the `.sql` hooks registered. */
async function runApp(
  queries: string,
  app: string,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-register-"));
  try {
    await writeFile(join(root, "queries.sql"), queries);
    await writeFile(join(root, "app.mjs"), app);
    const child = spawn(process.execPath, ["--import", register, "app.mjs"], { cwd: root });
    const [stdout, stderr] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      once(child, "close"),
    ]);
    return { stdout, stderr, code: child.exitCode };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const app = [
  `import { PGlite } from ${JSON.stringify(pglite)};`,
  `import { pgliteConnection } from ${JSON.stringify(pgliteConnection)};`,
  'import { add } from "./queries.sql";',
  "const db = await PGlite.create();",
  "const row = await add.one(pgliteConnection(db), { a: 1, b: 2 });",
  "console.log(JSON.stringify(row));",
  "await db.close();",
].join("\n");

describe("importing .sql files in Node", () => {
  test("exports each query, run with named parameters and decoded rows", async () => {
    const result = await runApp(
      "-- @name add\nselect :a::int4 + :b::int4 as sum, :a::int4 as a",
      app,
    );
    expect(result).toStrictEqual({ stdout: '{"sum":3,"a":1}\n', stderr: "", code: 0 });
  }, 30_000);

  test("exports a query whose name the generated module itself uses", async () => {
    const result = await runApp(
      "-- @name defineQuery\nselect 1 as one\n-- @name add\nselect :a::int4 + :b::int4 as sum",
      app.replace(
        "JSON.stringify(row)",
        "JSON.stringify(row), typeof (await import('./queries.sql')).defineQuery",
      ),
    );
    expect(result).toStrictEqual({ stdout: '{"sum":3} function\n', stderr: "", code: 0 });
  }, 30_000);

  test("fails to import a file with problems, naming where each one is", async () => {
    const result = await runApp("-- @name add\nselect $1 as sum", app);
    expect({
      code: result.code,
      problem: /queries\.sql:2:8 .*/v.exec(result.stderr)?.[0],
    }).toStrictEqual({
      code: 1,
      problem: "queries.sql:2:8 Use :name parameters instead of $1",
    });
  }, 30_000);
});
