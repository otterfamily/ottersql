import { join } from "node:path";

import { succeeded } from "./command.ts";
import { logFormat, parseLog, releaseNotes } from "./notes.ts";
import { nextVersion, sharedVersion } from "./version.ts";
import type { Bump } from "./version.ts";
import { publishedPackages, setVersion } from "./workspace.ts";

/** Refuses uncommitted changes, which would not be in what is published, and branches but main. */
async function refuseUnreleasable(root: string): Promise<void> {
  const changes = await succeeded("git", ["status", "--porcelain"], root);
  if (changes !== "") {
    throw new Error("commit or stash your changes first: a release holds only what is committed");
  }
  const branch = await succeeded("git", ["branch", "--show-current"], root);
  if (branch.trim() !== "main") {
    throw new Error(`releases are made from main, not ${JSON.stringify(branch.trim())}`);
  }
}

/**
 * Moves every published package to the next version, commits that and tags it `v<version>`;
 * pushing the tag publishes them (release.yml). Returns the tag. Every release comes from main.
 */
export async function bumpVersion(root: string, bump: Bump): Promise<string> {
  await refuseUnreleasable(root);
  const packages = await publishedPackages(root);
  const current = sharedVersion(new Map(packages.map(({ name, version }) => [name, version])));
  const tag = `v${nextVersion(current, bump)}`;
  await Promise.all(packages.map(async ({ directory }) => setVersion(directory, tag.slice(1))));
  const manifests = packages.map(({ directory }) => join(directory, "package.json"));
  await succeeded("git", ["add", ...manifests], root);
  await succeeded("git", ["commit", "--message", `chore: release ${tag}`], root);
  await succeeded("git", ["tag", "--annotate", tag, "--message", tag], root);
  return tag;
}

/** The notes for `tag`: what changed since the release before it, linking commits in `repository`. */
export async function notesFor(root: string, tag: string, repository: string): Promise<string> {
  const previous = await succeeded(
    "git",
    ["describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`],
    root,
  ).catch(() => null);
  if (previous === null) {
    return "The first release.\n";
  }
  const range = `${previous.trim()}..${tag}`;
  const log = await succeeded("git", ["log", `--format=${logFormat}`, range], root);
  return releaseNotes(parseLog(log), repository);
}
