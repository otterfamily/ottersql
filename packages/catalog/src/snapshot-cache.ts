import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env, execPath, pid, platform } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * A snapshot of an empty PGlite database, made once per PGlite build and kept in the user's cache
 * directory. It is made in a child process so the memory initialising a database takes is returned
 * to the operating system instead of staying with a long-running content mapper. It is not
 * compressed: decompressing it took a third of the time PGlite needs to start from it.
 */
export async function cachedEmptySnapshot(): Promise<Blob> {
  const file = join(cacheDirectory(), `pglite-empty-${await pgliteBuild()}.tar`);
  const cached = await readFile(file).catch(() => null);
  if (cached === null) {
    await mkdir(dirname(file), { recursive: true });
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

/** How many databases with a schema applied are kept; each is tens of megabytes. */
const KEPT_SCHEMA_SNAPSHOTS = 3;
const SCHEMA_PREFIX = "pglite-schema-";

/**
 * The key of a database with `parts` applied, for `cachedSchemaSnapshot`. It covers the PGlite
 * build because a snapshot fits only its own build.
 */
export async function schemaSnapshotKey(parts: readonly string[]): Promise<string> {
  return createHash("sha256")
    .update(JSON.stringify([await pgliteBuild(), ...parts]))
    .digest("hex");
}

function schemaSnapshotFile(key: string): string {
  return join(cacheDirectory(), `${SCHEMA_PREFIX}${key}.tar`);
}

/** The database saved under `key`, or `null`; reading it marks it as recently used. */
export async function cachedSchemaSnapshot(key: string): Promise<Blob | null> {
  const file = schemaSnapshotFile(key);
  const cached = await readFile(file).catch(() => null);
  if (cached === null) {
    return null;
  }
  const now = new Date();
  await utimes(file, now, now).catch(() => null);
  return new Blob([cached]);
}

/**
 * Saves a database under `key` and forgets all but the most recently used few. Failing to save
 * only costs the next start its time, so errors are ignored.
 */
export async function saveSchemaSnapshot(key: string, snapshot: Blob): Promise<void> {
  const file = schemaSnapshotFile(key);
  const temporary = `${file}.${String(pid)}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, new Uint8Array(await snapshot.arrayBuffer()));
    await rename(temporary, file);
    await pruneSchemaSnapshots();
  } catch {
    await rm(temporary, { force: true });
  }
}

async function pruneSchemaSnapshots(): Promise<void> {
  const directory = cacheDirectory();
  const entries = await readdir(directory);
  const names = entries.filter((name) => name.startsWith(SCHEMA_PREFIX) && name.endsWith(".tar"));
  const used = await Promise.all(
    names.map(async (name) => {
      const { mtimeMs } = await stat(join(directory, name));
      return { name, time: mtimeMs };
    }),
  );
  const old = used.toSorted((left, right) => right.time - left.time).slice(KEPT_SCHEMA_SNAPSHOTS);
  await Promise.all(old.map(async ({ name }) => rm(join(directory, name), { force: true })));
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
