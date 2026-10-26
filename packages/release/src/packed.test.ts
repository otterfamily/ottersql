import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bunExecutable } from "@ottersql/testing";
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

/** The tarball npm would get of each published package, by name, written to `directory`. */
async function packedPackages(directory: string): Promise<Record<string, string>> {
  await succeeded("pnpm", ["build"], root);
  const sources = await publishedPackages(root);
  return Object.fromEntries(
    await Promise.all(sources.map(async ({ directory: source }) => pack(source, directory))),
  );
}

/** Settings that make `pnpm install` take the packages from their tarballs. */
async function useTarballs(
  project: string,
  tarballs: Readonly<Record<string, string>>,
): Promise<void> {
  // The packages depend on each other by a version npm does not have until they are published.
  const overrides = Object.entries(tarballs).map(([name, file]) => `  "${name}": "file:${file}"`);
  await writeFile(join(project, "pnpm-workspace.yaml"), `overrides:\n${overrides.join("\n")}\n`);
}

/**
 * The playground, outside the workspace, with every ottersql package installed from the tarball
 * npm would get: only what the packages publish is there, so nothing reaches the TypeScript sources.
 */
async function installedPlayground(
  directory: string,
  tarballs: Readonly<Record<string, string>>,
): Promise<string> {
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
  await useTarballs(project, tarballs);
  await succeeded("pnpm", ["install", "--prefer-offline"], project);
  return project;
}

/** A project that installs ottersql and pg alone, as a deploy that leaves out dev dependencies does. */
async function installedForProduction(
  directory: string,
  tarballs: Readonly<Record<string, string>>,
): Promise<string> {
  const project = join(directory, "production");
  await mkdir(project);
  const pg = await versionIn(join(root, "examples", "migrations", "node_modules", "pg"));
  const manifest = {
    name: "production",
    private: true,
    type: "module",
    dependencies: { pg, ...tarballs },
  };
  await writeFile(join(project, "package.json"), JSON.stringify(manifest));
  await useTarballs(project, tarballs);
  await succeeded("pnpm", ["install", "--prefer-offline"], project);
  return project;
}

const test = base.extend<{
  packed: { directory: string; tarballs: Readonly<Record<string, string>> };
  project: string;
  production: string;
}>({
  packed: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "ottersql-packed-"));
      await use({ directory, tarballs: await packedPackages(directory) });
      await rm(directory, { recursive: true, force: true });
    },
    { scope: "file" },
  ],
  project: [
    async ({ packed }, use) => {
      await use(await installedPlayground(packed.directory, packed.tarballs));
    },
    { scope: "file" },
  ],
  production: [
    async ({ packed }, use) => {
      await use(await installedForProduction(packed.directory, packed.tarballs));
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

  test("give the bundler plugins and loader", async ({ project }) => {
    const entries = ["vite", "esbuild", "webpack"].map((name) => `ottersql/${name}`);
    const script = `for (const entry of ${JSON.stringify(entries)}) console.log(Object.values(await import(entry)).map((value) => typeof value).join())`;
    await expect(succeeded("node", ["--eval", script], project)).resolves.toBe(
      "function\nfunction\nfunction\n",
    );
  });

  test("run .sql imports through the register hook", async ({ project }) => {
    const args = ["--import", "ottersql/register", "app.ts"];
    await expect(succeeded("node", args, project)).resolves.toContain("author: 'Otter'");
  });

  test("run .sql imports in Bun, through the same register entry", async ({ project }) => {
    const args = ["--preload", "ottersql/register", "app.ts"];
    await expect(succeeded(bunExecutable, args, project)).resolves.toContain("Otter");
  });

  test("load the migrate and catalog entries without PGlite, which only development needs", async ({
    production,
  }) => {
    const script =
      'for (const entry of ["ottersql/migrate", "ottersql/catalog"]) console.log(typeof (await import(entry)))';
    await expect(succeeded("node", ["--eval", script], production)).resolves.toBe(
      "object\nobject\n",
    );
  });

  test("apply migrations without PGlite, reaching the database first", async ({ production }) => {
    const args = ["exec", "ottersql", "migrate", "apply", "--json"];
    const { exitCode, stdout } = await run("pnpm", args, production);
    const json: unknown = JSON.parse(stdout);
    expect({ exitCode, json }).toMatchObject({
      exitCode: 2,
      json: { ok: false, code: "database.url_missing" },
    });
  });
});
