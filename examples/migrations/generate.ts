// Writes the next migration: what db/schema.sql adds to the schema the migrations so far build.
// Usage: pnpm generate <name>
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { pendingChanges, renderMigration } from "@ottersql/migrate";

import { migrationsDirectory, readMigrations, schemaFile } from "./files.ts";

const {
  positionals: [name = "change"],
} = parseArgs({ allowPositionals: true });
const plan = await pendingChanges(await readMigrations(), await readFile(schemaFile, "utf8"));

if (plan.steps.length === 0 && plan.manual.length === 0) {
  console.log("The migrations already build db/schema.sql.");
} else {
  const stamp = new Date().toISOString().replaceAll(/\D/gv, "").slice(0, "YYYYMMDDHHMMSS".length);
  const file = `${stamp}_${name}.sql`;
  await writeFile(new URL(file, migrationsDirectory), renderMigration(plan));
  console.log(`Wrote db/migrations/${file}: ${String(plan.steps.length)} steps.`);
  for (const change of plan.manual) {
    console.log(`Write by hand: ${change.object}: ${change.reason}`);
  }
}
