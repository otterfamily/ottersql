import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { emptySnapshotFile, saveSchemaSnapshot } from "./snapshot-cache.ts";

/** Points every platform's cache directory into a new temporary home for the current test. */
async function temporaryHome(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ottersql-cache-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
  vi.stubEnv("LOCALAPPDATA", join(home, "AppData"));
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
}

describe("the snapshot cache", () => {
  test("keeps the installed build's empty database and the three most recently used schemas", async () => {
    await temporaryHome();
    const empty = await emptySnapshotFile();
    const directory = dirname(empty);
    await mkdir(directory, { recursive: true });
    const seeded = [
      basename(empty),
      "pglite-empty-0000000000000000.tar",
      `${basename(empty)}.gz`,
      "pglite-schema-old.tar",
      "pglite-schema-older.tar",
      "pglite-schema-recent.tar",
    ];
    for (const name of seeded) {
      await writeFile(join(directory, name), "");
    }
    const ages = { "pglite-schema-older.tar": 3, "pglite-schema-old.tar": 2 };
    for (const [name, days] of Object.entries(ages)) {
      const then = new Date(Date.now() - days * 86_400_000);
      await utimes(join(directory, name), then, then);
    }
    await saveSchemaSnapshot("new", new Blob([""]));
    const kept = await readdir(directory);
    expect(kept.toSorted()).toStrictEqual(
      [
        basename(empty),
        "pglite-schema-new.tar",
        "pglite-schema-old.tar",
        "pglite-schema-recent.tar",
      ].toSorted(),
    );
  });
});
