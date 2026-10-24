import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createMapper } from "./index.ts";

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

describe("content mapper protocol", () => {
  test("retypes queries when schema.sql changes, without restarting", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      const schemaPath = join(root, "schema.sql");
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

  test("maps the schema file itself to an empty module", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottersql-mapper-"));
    const mapper = createMapper();
    try {
      const schemaPath = join(root, "schema.sql");
      await writeFile(schemaPath, "create table t (id int);");
      await mapper("openProject", {
        projectHandle: "p",
        configFileName: join(root, "tsconfig.json"),
      });
      const schema = await transform(mapper, schemaPath, "create table t (id int);");
      expect(schema).toStrictEqual({
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
});
