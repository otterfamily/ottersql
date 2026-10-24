import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, test } from "vitest";

const packages = resolve(import.meta.dirname, "../..");
const tsc = resolve(import.meta.dirname, "../node_modules/.bin/tsc");

const tsconfig = {
  compilerOptions: {
    target: "es2025",
    module: "nodenext",
    lib: ["esnext"],
    strict: true,
    noEmit: true,
    types: [],
    allowImportingTsExtensions: true,
  },
  contentMappers: [
    {
      package: "@ottersql/content-mapper",
      extensions: [".sql"],
      options: { schema: "schema.sql" },
    },
  ],
  include: ["."],
};

const schemaSql = `
create table users (id int8 primary key, name text not null, bio text);
create table posts (
  id int8 primary key,
  author_id int8 not null references users (id),
  title text not null,
  status text not null check (status in ('draft', 'published'))
);
`;

/** Runs `tsc` in `root` and returns what it printed. */
async function runTsc(root: string): Promise<string> {
  const child = spawn(tsc, ["-p", ".", "--runExternalCode"], { cwd: root });
  const [stdout] = await Promise.all([text(child.stdout), once(child, "close")]);
  return stdout;
}

/** Type-checks a project made of `files` with `tsc --runExternalCode`, and returns its errors. */
async function typeCheck(files: Readonly<Record<string, string>>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-content-mapper-"));
  try {
    await mkdir(join(root, "node_modules/@ottersql"), { recursive: true });
    for (const name of ["content-mapper", "sql", "catalog"]) {
      await symlink(join(packages, name), join(root, "node_modules/@ottersql", name), "dir");
    }
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(tsconfig));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content);
    }
    const stdout = await runTsc(root);
    return stdout.split("\n").filter((line) => line.includes("error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const queries = [
  "-- @name postsByAuthor",
  "select p.title, p.status, u.bio",
  "from posts p join users u on u.id = p.author_id",
  "where p.author_id = :authorId;",
].join("\n");

describe("tsc with the content mapper", () => {
  test("types a .sql import, and rejects code that misuses it", async () => {
    const errors = await typeCheck({
      "schema.sql": schemaSql,
      "queries.sql": queries,
      "app.ts": [
        'import type { Connection } from "@ottersql/sql";',
        'import { postsByAuthor } from "./queries.sql";',
        "declare const connection: Connection;",
        'const rows = await postsByAuthor(connection, { authorId: "1" });',
        'const status: "draft" | "published" | undefined = rows[0]?.status;',
        "const title: string | undefined = rows[0]?.title;",
        "const bio: string | undefined = rows[0]?.bio;",
        "await postsByAuthor(connection, { authorId: 1 });",
        "export { bio, status, title };",
      ].join("\n"),
    });
    expect(errors).toStrictEqual([
      "app.ts(7,7): error TS2322: Type 'string | null' is not assignable to type 'string | undefined'.",
      "app.ts(8,35): error TS2322: Type 'number' is not assignable to type 'string'.",
    ]);
  }, 60_000);

  test("reports a Postgres error at its place in the .sql file", async () => {
    const errors = await typeCheck({
      "schema.sql": schemaSql,
      "queries.sql": `${queries}\n\n-- @name broken\nselect missing from posts;`,
    });
    expect(errors).toStrictEqual([
      'queries.sql(7,8): error sql9002: column "missing" does not exist',
    ]);
  }, 60_000);
});
