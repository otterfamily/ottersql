import { stdout } from "node:process";
import { parseArgs } from "node:util";

import { bumpVersion, notesFor } from "./release.ts";
import { bumps } from "./version.ts";

const usage = `usage:
  pnpm release <${bumps.join("|")}>   commit and tag the next version of every package
  node packages/release/src/cli.ts notes <tag> <repository URL>   print the release notes of a tag`;

// The first two are the Node.js executable and this script.
const FIRST_ARGUMENT = 2;
const {
  positionals: [command, ...rest],
} = parseArgs({ args: process.argv.slice(FIRST_ARGUMENT), allowPositionals: true });
const root = process.cwd();
const [first, second, ...extra] = rest;
const bump = bumps.find((name) => name === first);

if (command === "bump" && bump !== undefined && second === undefined) {
  const tag = await bumpVersion(root, bump);
  stdout.write(`Tagged ${tag}. Push it to publish: git push --follow-tags\n`);
} else if (
  command === "notes" &&
  first !== undefined &&
  second !== undefined &&
  extra.length === 0
) {
  stdout.write(await notesFor(root, first, second));
} else {
  throw new Error(usage);
}
