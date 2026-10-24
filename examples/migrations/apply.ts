// Applies the migrations not yet applied to DATABASE_URL.
// Usage: pnpm apply [expand|contract]
import { parseArgs } from "node:util";

import { applyMigrations } from "@ottersql/migrate";
import { pgConnection } from "@ottersql/sql/pg";
import { Client } from "pg";

import { databaseUrl, readMigrations } from "./files.ts";

const INDENT = 2;

const {
  positionals: [phase],
} = parseArgs({ allowPositionals: true });
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await applyMigrations(
    pgConnection(client),
    await readMigrations(),
    phase === "expand" || phase === "contract" ? { phase } : {},
  );
  console.log(JSON.stringify(result, null, INDENT));
  process.exitCode = result.failed === null ? 0 : 1;
} finally {
  await client.end();
}
