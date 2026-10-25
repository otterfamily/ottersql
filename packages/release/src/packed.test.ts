import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { test as base, describe, expect } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const playground = join(root, "examples", "playground");
// The editor settings and the code that is wrong on purpose are not part of what is checked.
const left = new Set(["node_modules", ".vscode", "mistakes"]);

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string, args: readonly string[], cwd: string): Promise<Run> {
  const child = spawn(command, args, { cwd });
  const [stdout, stderr, exit] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "exit"),
  ]);
  const code: unknown = exit[0];
  return { exitCode: typeof code === "number" ? code : 1, stdout, stderr };
}

async function succeeded(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await run(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

/** The string at `key` of parsed JSON. */
function stringAt(value: unknown, key: string): string {
  const found: unknown =
    typeof value === "object" && value !== null
      ? Object.entries(value).find(([name]) => name === key)?.[1]
      : undefined;
  if (typeof found !== "string") {
    throw new TypeError(`expected a string at ${key} in ${JSON.stringify(value)}`);
  }
  return found;
}

async function manifestOf(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

/** The directories of the packages published to npm: those under packages/ not marked private. */
async function publishedPackages(): Promise<string[]> {
  const names = await readdir(join(root, "packages"));
  const directories = names.map((name) => join(root, "packages", name));
  const published = await Promise.all(
    directories.map(async (directory) => {
      const manifest = await manifestOf(directory);
      return typeof manifest === "object" && manifest !== null && !("private" in manifest);
    }),
  );
  return directories.filter((_directory, index) => published[index] === true);
}

/** The package's name and the tarball `pnpm pack` writes for it to `destination`. */
async function pack(directory: string, destination: string): Promise<[string, string]> {
  const args = ["pack", "--json", "--pack-destination", destination];
  const packed: unknown = JSON.parse(await succeeded("pnpm", args, directory));
  return [stringAt(packed, "name"), stringAt(packed, "filename")];
}

/** The version of `name` the playground has in the workspace, which its copy gets too. */
async function versionOf(name: string): Promise<string> {
  return stringAt(await manifestOf(join(playground, "node_modules", name)), "version");
}

/**
 * The playground, outside the workspace, with every ottersql package installed from the tarball
 * npm would get: only what the packages publish is there, so nothing reaches the TypeScript sources.
 */
async function installedPlayground(directory: string): Promise<string> {
  await succeeded("pnpm", ["build"], root);
  const sources = await publishedPackages();
  const tarballs: Record<string, string> = Object.fromEntries(
    await Promise.all(sources.map(async (source) => pack(source, directory))),
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

  test("run .sql imports through the register hook", async ({ project }) => {
    const args = ["--import", "@ottersql/sql/register", "app.ts"];
    await expect(succeeded("node", args, project)).resolves.toContain("author: 'Otter'");
  });
});
