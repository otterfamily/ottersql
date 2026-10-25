import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { succeeded } from "./command.ts";
import { bumpVersion, notesFor } from "./release.ts";
import { versionIn } from "./workspace.ts";

const repository = "https://github.com/otterfamily/ottersql";

async function git(root: string, ...args: readonly string[]): Promise<string> {
  return succeeded("git", args, root);
}

/** A repository on main with two published packages and a private one, all at `version`. */
async function workspace(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ottersql-release-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const packages = { a: false, b: false, testing: true };
  await Promise.all(
    Object.entries(packages).map(async ([name, isPrivate]) => {
      await mkdir(join(root, "packages", name), { recursive: true });
      const manifest = { name: `@x/${name}`, version, ...(isPrivate ? { private: true } : {}) };
      await writeFile(join(root, "packages", name, "package.json"), JSON.stringify(manifest));
    }),
  );
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "--message", "feat: start");
  return root;
}

describe("a release", () => {
  test("moves every published package to the next version, commits it and tags it", async () => {
    const root = await workspace("0.0.0");
    await expect(bumpVersion(root, "minor")).resolves.toBe("v0.1.0");
    await expect(
      Promise.all(
        ["a", "b", "testing"].map(async (name) => versionIn(join(root, "packages", name))),
      ),
    ).resolves.toStrictEqual(["0.1.0", "0.1.0", "0.0.0"]);
    await expect(git(root, "log", "-1", "--format=%s")).resolves.toBe("chore: release v0.1.0\n");
    await expect(git(root, "status", "--porcelain")).resolves.toBe("");
    await expect(git(root, "describe", "--tags")).resolves.toBe("v0.1.0\n");
  });

  test("is refused while changes are not committed", async () => {
    const root = await workspace("0.1.0");
    await writeFile(join(root, "notes.txt"), "draft");
    await expect(bumpVersion(root, "patch")).rejects.toThrow(
      "commit or stash your changes first: a release holds only what is committed",
    );
  });

  test("is refused on a branch other than main", async () => {
    const root = await workspace("0.1.0");
    await git(root, "switch", "--quiet", "--create", "topic");
    await expect(bumpVersion(root, "patch")).rejects.toThrow(
      'releases are made from main, not "topic"',
    );
  });

  test("has notes listing what changed since the release before it", async () => {
    const root = await workspace("0.0.0");
    await bumpVersion(root, "minor");
    await expect(notesFor(root, "v0.1.0", repository)).resolves.toBe("The first release.\n");
    await git(root, "commit", "--quiet", "--allow-empty", "--message", "fix: one");
    await bumpVersion(root, "patch");
    await expect(notesFor(root, "v0.1.1", repository)).resolves.toMatch(
      /^## Fixes\n{2}- one \(\[[0-9a-f]{7}\]/v,
    );
  });
});
