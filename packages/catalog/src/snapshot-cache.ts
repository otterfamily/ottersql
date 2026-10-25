import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env, execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * A gzip snapshot of an empty PGlite database, made once per PGlite build and kept in the user's
 * cache directory. It is made in a child process so the memory initialising a database takes is
 * returned to the operating system instead of staying with a long-running content mapper.
 */
export async function cachedEmptySnapshot(): Promise<Blob> {
  const directory = cacheDirectory();
  const file = join(directory, `pglite-empty-${await pgliteBuild()}.tar.gz`);
  const cached = await readFile(file).catch(() => null);
  if (cached === null) {
    await mkdir(directory, { recursive: true });
    await makeSnapshot(file);
  }
  return new Blob([cached ?? (await readFile(file))]);
}

async function makeSnapshot(file: string): Promise<void> {
  const script = fileURLToPath(import.meta.resolve("#snapshot-child"));
  // The content mapper's stdout carries JSON-RPC, so the child may only write to stderr.
  const child = spawn(execPath, [script, file], { stdio: ["ignore", "ignore", "inherit"] });
  const exit = await once(child, "exit");
  const code: unknown = exit[0];
  if (code !== 0) {
    throw new Error(`making the empty database snapshot failed with exit code ${String(code)}`);
  }
}

/** The per-user cache directory each platform documents for applications. */
function cacheDirectory(): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ottersql");
  }
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "ottersql", "Cache");
  }
  return join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "ottersql");
}

const BUILD_ID_LENGTH = 16;

/** Identifies the PGlite build by its WebAssembly binary, since a snapshot fits only its own build. */
async function pgliteBuild(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  const wasm = await readFile(join(dirname(entry), "pglite.wasm"));
  return createHash("sha256").update(wasm).digest("hex").slice(0, BUILD_ID_LENGTH);
}
