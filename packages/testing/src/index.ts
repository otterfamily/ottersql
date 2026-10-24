import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { inject, onTestFinished } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Set by the global setup that starts the shared Postgres container. */
    postgresAdminUrl: string;
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
