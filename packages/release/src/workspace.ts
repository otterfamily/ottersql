import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A package npm users install: one under packages/ that is not marked private. */
export interface PublishedPackage {
  readonly name: string;
  readonly directory: string;
  readonly version: string;
}

function manifestPath(directory: string): string {
  return join(directory, "package.json");
}

async function manifestOf(directory: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath(directory), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`${manifestPath(directory)} does not hold an object`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/** The string at `key` of `manifest`, or `null` when there is none. */
export function stringAt(manifest: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = manifest[key];
  return typeof value === "string" ? value : null;
}

/** The version of the package in `directory`. */
export async function versionIn(directory: string): Promise<string> {
  const version = stringAt(await manifestOf(directory), "version");
  if (version === null) {
    throw new TypeError(`${manifestPath(directory)} has no version`);
  }
  return version;
}

export async function publishedPackages(root: string): Promise<PublishedPackage[]> {
  const entries = await readdir(join(root, "packages"));
  const names = entries.toSorted();
  const found = await Promise.all(
    names.map(async (name) => {
      const directory = join(root, "packages", name);
      const manifest = await manifestOf(directory);
      const packageName = stringAt(manifest, "name");
      const version = stringAt(manifest, "version");
      return manifest["private"] === true || packageName === null || version === null
        ? []
        : [{ name: packageName, directory, version }];
    }),
  );
  return found.flat();
}

// The indentation the formatter gives package.json.
const indent = 2;

/** Sets the version of the package in `directory`, keeping the rest of its manifest as it is. */
export async function setVersion(directory: string, version: string): Promise<void> {
  const manifest = await manifestOf(directory);
  await writeFile(
    manifestPath(directory),
    `${JSON.stringify({ ...manifest, version }, null, indent)}\n`,
  );
}
