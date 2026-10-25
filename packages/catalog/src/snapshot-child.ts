import { rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { PGlite } from "@electric-sql/pglite";

// Runs in its own short-lived process: initialising a database grows PGlite's memory by about a
// gigabyte, which this process gives back to the operating system when it exits.
const {
  positionals: [target],
} = parseArgs({ allowPositionals: true });
if (target === undefined) {
  throw new Error("usage: snapshot-child.ts <target file>");
}
const db = await PGlite.create();
const snapshot = await db.dumpDataDir("none");
await db.close();
const temporary = `${target}.${String(process.pid)}.tmp`;
await writeFile(temporary, new Uint8Array(await snapshot.arrayBuffer()));
await rename(temporary, target);
