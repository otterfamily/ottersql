import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createMapper } from "./mapper.ts";

interface Transformed {
  readonly text: string;
  readonly diagnostics: readonly { readonly messageText: string }[];
}

function isTransformed(value: unknown): value is Transformed {
  return typeof value === "object" && value !== null && "text" in value && "diagnostics" in value;
}

async function transform(
  mapper: ReturnType<typeof createMapper>,
  fileName: string,
  content: string,
): Promise<Transformed> {
  const result = await mapper("transform", { projectHandle: "p", fileName, content });
  if (!isTransformed(result)) {
    throw new TypeError("transform returned no module");
  }
  return result;
}

/** Where a project with no `schema` option keeps its schema, after creating its directory. */
async function defaultSchemaFile(root: string): Promise<string> {
  await mkdir(join(root, "db"));
  return join(root, "db", "schema.sql");
}

/** Writes `schema` as the project's schema.sql, or leaves the file out when it is `null`. */
async function writeSchema(root: string, schema: string | null): Promise<void> {
  if (schema !== null) {
    await writeFile(await defaultSchemaFile(root), schema);
  }
}

describe("content mapper protocol", () => {
  test("retypes queries when schema.sql changes, without restarting", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      const schemaPath = await defaultSchemaFile(root);
      const project = {
        projectHandle: "p",
        configFileName: join(root, "tsconfig.json"),
        options: {},
      };
      const query = "-- @name q\nselect added from t";

      await writeFile(schemaPath, "create table t (id int);");
      const first = await mapper("openProject", project);
      const before = await transform(mapper, join(root, "queries.sql"), query);

      await writeFile(schemaPath, "create table t (id int, added text not null);");
      const second = await mapper("openProject", project);
      const after = await transform(mapper, join(root, "queries.sql"), query);

      expect({
        sameIdentity: JSON.stringify(first) === JSON.stringify(second),
        before: before.diagnostics.map(({ messageText }) => messageText),
        after: after.text.includes("readonly added: string;"),
      }).toStrictEqual({
        sameIdentity: false,
        before: ['column "added" does not exist'],
        after: true,
      });
    } finally {
      await mapper("closeProject", { projectHandle: "p" });
      await rm(root, { recursive: true, force: true });
    }
  });

  test.for([
    { label: "the schema file itself", file: "schema.sql" },
    { label: "a migration next to it", file: join("migrations", "20261025000000_init.sql") },
    { label: "another tool's .sql file, without -- @name", file: join("..", "seed.sql") },
  ])("maps $label to an empty module, since it holds no queries", async ({ file }) => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      const schemaPath = await defaultSchemaFile(root);
      await writeFile(schemaPath, "create table t (id int);");
      await mapper("openProject", {
        projectHandle: "p",
        configFileName: join(root, "tsconfig.json"),
      });
      const mapped = await transform(mapper, join(root, "db", file), "create table t (id int);");
      expect(mapped).toStrictEqual({
        text: "export {};\n",
        extension: ".ts",
        mappings: [],
        diagnostics: [],
      });
    } finally {
      await mapper("closeProject", { projectHandle: "p" });
      await rm(root, { recursive: true, force: true });
    }
  });

  test.for([
    {
      label: "an error in schema.sql",
      schema: "create table t (id int;",
      expected: /schema\.sql:1:23: syntax error at or near ";"$/v,
    },
    { label: "a missing schema.sql", schema: null, expected: /schema\.sql: cannot be read/v },
  ])("reports $label at the head of every query file", async ({ schema, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      await writeSchema(root, schema);
      await mapper("openProject", {
        projectHandle: "p",
        configFileName: join(root, "tsconfig.json"),
      });
      const file = await transform(mapper, join(root, "queries.sql"), "-- @name q\nselect 1");
      expect(file.diagnostics.map(({ messageText }) => messageText)).toStrictEqual([
        expect.stringMatching(expected),
      ]);
    } finally {
      await mapper("closeProject", { projectHandle: "p" });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("answers a transform asked for while schema.sql changes, before closing the old schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      const schemaPath = await defaultSchemaFile(root);
      const project = { projectHandle: "p", configFileName: join(root, "tsconfig.json") };
      await writeFile(schemaPath, "create table t (id int);");
      await mapper("openProject", project);
      const queries = [1, 2, 3, 4, 5].map(
        (index) => `-- @name q${String(index)}\nselect id + ${String(index)} as n from t`,
      );
      const transforms = queries.map(async (query) =>
        transform(mapper, join(root, "queries.sql"), query),
      );
      await writeFile(schemaPath, "create table t (id int, added text);");
      const reopened = mapper("openProject", project);
      const files = await Promise.all(transforms);
      await reopened;
      expect(files.flatMap(({ diagnostics }) => diagnostics)).toStrictEqual([]);
    } finally {
      await mapper("closeProject", { projectHandle: "p" });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("answers an unknown method with JSON-RPC's method-not-found error", async () => {
    await expect(createMapper()("nonsense", {})).rejects.toMatchObject({ code: -32_601 });
  });
});
