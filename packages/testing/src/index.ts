import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { inject, onTestFinished } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Set by the global setup that starts the shared Postgres container. */
    postgresAdminUrl: string;
    /** The major version that container runs. */
    postgresMajor: number;
  }
}

/** An in-process Postgres for the current test, closed when the test finishes. */
export async function pglite(schemaSql?: string): Promise<PGlite> {
  const db = await PGlite.create();
  onTestFinished(async () => db.close());
  if (schemaSql !== undefined) {
    await db.exec(schemaSql);
  }
  return db;
}

/**
 * A fresh database on the shared Postgres container for the current test, dropped when the test
 * finishes. Returns a connection URL so each caller can pick its own driver.
 */
export async function postgresDatabase(schemaSql?: string): Promise<string> {
  const database = await createPostgresDatabase(schemaSql);
  onTestFinished(database.drop);
  return database.url;
}

/**
 * A fresh database on the shared Postgres container that lives until `drop` is called, for
 * fixtures shared by several tests.
 */
export async function createPostgresDatabase(
  schemaSql?: string,
): Promise<{ readonly url: string; readonly drop: () => Promise<void> }> {
  const adminUrl = inject("postgresAdminUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await withClient(adminUrl, async (client) => client.query(`create database ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (schemaSql !== undefined) {
    await withClient(url.toString(), async (client) => client.query(schemaSql));
  }
  return {
    url: url.toString(),
    drop: async () => {
      await withClient(adminUrl, async (client) =>
        client.query(`drop database ${name} with (force)`),
      );
    },
  };
}

async function withClient<Result>(
  url: string,
  use: (client: Client) => Promise<Result>,
): Promise<Result> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** The Bun executable, pinned by this package's `devEngines`, for tests that run code in Bun. */
export const bunExecutable: string = fileURLToPath(
  new URL("../node_modules/.bin/bun", import.meta.url),
);

/** Runs `script` in Bun in `cwd`; rejects with what it printed to stderr when it fails. */
export async function runInBun(script: string, cwd: string): Promise<void> {
  const child = spawn(bunExecutable, ["--eval", script], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [stderr] = await Promise.all([text(child.stderr), once(child, "close")]);
  if (child.exitCode !== 0) {
    throw new Error(`Bun exited with ${String(child.exitCode)}: ${stderr}`);
  }
}
