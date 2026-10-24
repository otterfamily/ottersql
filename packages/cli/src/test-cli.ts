import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vitest";

import { main } from "./main.ts";

/** What one run of the CLI printed and exited with. */
export interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly agent?: string;
}

/** A directory for the current test, removed when it finishes, holding `files` by relative path. */
export async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-cli-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await writeFiles(root, files);
  return root;
}

export async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** The moment `generate` stamps migrations with in these tests. */
const now: Date = new Date("2026-10-25T12:34:56Z");

/** Runs `ottersql <args>` in `cwd`. */
export async function ottersql(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const exitCode = await main(args, {
    cwd,
    env: options.env ?? {},
    agent: options.agent ?? null,
    now,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

/** Runs `ottersql <args> --json`, and reads the one JSON value it printed. */
export async function ottersqlJson(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<{ readonly exitCode: number; readonly json: unknown }> {
  const { exitCode, stdout } = await ottersql(cwd, [...args, "--json"], options);
  return { exitCode, json: parseJson(stdout) };
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** The value at `path` in parsed JSON, or `undefined` where there is none. */
export function at(value: unknown, ...path: readonly string[]): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return value;
  }
  return typeof value === "object" && value !== null && key in value
    ? at(Reflect.get(value, key), ...rest)
    : undefined;
}
