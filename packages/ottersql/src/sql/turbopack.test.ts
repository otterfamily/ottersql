import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, execPath } from "node:process";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

const loader = fileURLToPath(import.meta.resolve("./webpack.ts"));
const nextCli = fileURLToPath(import.meta.resolve("next/dist/bin/next"));

const files: Readonly<Record<string, string>> = {
  "queries.sql": "-- @name greeting\nselect 'hello' as message;\n",
  "next.config.mjs": `export default { turbopack: { rules: { "*.sql": { loaders: [${JSON.stringify(loader)}], as: "*.js" } } } };\n`,
  // Without JSX: Turbopack leaves files under node_modules, where this project has to live to
  // find Next.js and React, untransformed.
  "app/layout.js": [
    'import { createElement } from "react";',
    "export default function Layout({ children }) {",
    '  return createElement("html", null, createElement("body", null, children));',
    "}",
    "",
  ].join("\n"),
  "app/page.js": [
    'import { greeting } from "../queries.sql";',
    "export default function Page() {",
    '  return typeof greeting === "function" && "one" in greeting ? "query loaded" : "no query";',
    "}",
    "",
  ].join("\n"),
};

/** A Next.js project in this package's `node_modules/.cache`, removed after the test. */
async function nextProject(): Promise<string> {
  const cache = fileURLToPath(new URL("../../node_modules/.cache", import.meta.url));
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "ottersql-next-"));
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app"));
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => writeFile(join(root, name), content)),
  );
  return root;
}

/** Runs `next build` in `root`, rejecting with its output when the build fails. */
async function nextBuild(root: string): Promise<void> {
  const child = spawn(execPath, [nextCli, "build", "--turbopack"], {
    cwd: root,
    env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "close"),
  ]);
  if (child.exitCode !== 0) {
    throw new Error(`next build exited with ${String(child.exitCode)}:\n${stdout}${stderr}`);
  }
}

describe("bundling .sql files with Next.js and Turbopack", () => {
  test("builds pages that import their queries", async () => {
    const root = await nextProject();
    await nextBuild(root);
    const page = await readFile(join(root, ".next", "server", "app", "index.html"), "utf8");
    expect(page).toContain("query loaded");
  });
});
