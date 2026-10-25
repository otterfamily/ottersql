import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, describe, expect } from "vitest";

import { run, succeeded } from "./command.ts";
import { publishedPackages, stringAt, versionIn } from "./workspace.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const playground = join(root, "examples", "playground");
// The editor settings and the code that is wrong on purpose are not part of what is checked.
const left = new Set(["node_modules", ".vscode", "mistakes"]);

/** The string at `key` of parsed JSON. */
function stringOf(value: unknown, key: string): string {
  const found =
    typeof value === "object" && value !== null
      ? stringAt(Object.fromEntries(Object.entries(value)), key)
      : null;
  if (found === null) {
    throw new TypeError(`expected a string at ${key} in ${JSON.stringify(value)}`);
  }
  return found;
}

/** The package's name and the tarball `pnpm pack` writes for it to `destination`. */
async function pack(directory: string, destination: string): Promise<[string, string]> {
  const args = ["pack", "--json", "--pack-destination", destination];
  const packed: unknown = JSON.parse(await succeeded("pnpm", args, directory));
  return [stringOf(packed, "name"), stringOf(packed, "filename")];
}

/** The version of `name` the playground has in the workspace, which its copy gets too. */
async function versionOf(name: string): Promise<string> {
  return versionIn(join(playground, "node_modules", name));
}

/**
 * The playground, outside the workspace, with every ottersql package installed from the tarball
 * npm would get: only what the packages publish is there, so nothing reaches the TypeScript sources.
 */
async function installedPlayground(directory: string): Promise<string> {
  await succeeded("pnpm", ["build"], root);
  const sources = await publishedPackages(root);
  const tarballs: Record<string, string> = Object.fromEntries(
    await Promise.all(sources.map(async ({ directory: source }) => pack(source, directory))),
  );
  const project = join(directory, "project");
  await cp(playground, project, { recursive: true, filter: (path) => !left.has(basename(path)) });
  const manifest = {
    name: "installed-playground",
    private: true,
    type: "module",
    dependencies: { "@electric-sql/pglite": await versionOf("@electric-sql/pglite"), ...tarballs },
    devDependencies: {
      "@types/node": await versionOf("@types/node"),
      typescript: await versionOf("typescript"),
    },
  };
  await writeFile(join(project, "package.json"), JSON.stringify(manifest));
  // The packages depend on each other by a version npm does not have until they are published.
  const overrides = Object.entries(tarballs).map(([name, file]) => `  "${name}": "file:${file}"`);
  await writeFile(join(project, "pnpm-workspace.yaml"), `overrides:\n${overrides.join("\n")}\n`);
  await succeeded("pnpm", ["install", "--prefer-offline"], project);
  return project;
}

const test = base.extend<{ project: string }>({
  project: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "ottersql-packed-"));
      await use(await installedPlayground(directory));
      await rm(directory, { recursive: true, force: true });
    },
    { scope: "file" },
  ],
});

describe("the packages as npm installs them", () => {
  test("give the ottersql command, which finds that schema.sql has no migrations yet", async ({
    project,
  }) => {
    const args = ["exec", "ottersql", "migrate", "check", "--json"];
    const { exitCode, stdout } = await run("pnpm", args, project);
    expect(exitCode).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: "migrate.out_of_date" });
  });

  test("type .sql imports through the content mapper", async ({ project }) => {
    const args = ["exec", "tsc", "-p", "tsconfig.ci.json", "--runExternalCode"];
    await expect(run("pnpm", args, project)).resolves.toStrictEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("give the Vite plugin", async ({ project }) => {
    const args = ["--eval", 'console.log(typeof (await import("@ottersql/sql/vite")).ottersql)'];
    await expect(succeeded("node", args, project)).resolves.toBe("function\n");
  });

  test("run .sql imports through the register hook", async ({ project }) => {
    const args = ["--import", "@ottersql/sql/register", "app.ts"];
    await expect(succeeded("node", args, project)).resolves.toContain("author: 'Otter'");
  });
});
