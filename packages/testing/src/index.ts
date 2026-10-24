import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { inject, onTestFinished } from "vitest";

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
  const adminUrl = inject("postgresAdminUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await withClient(adminUrl, async (client) => client.query(`create database ${name}`));
  onTestFinished(async () => {
    await withClient(adminUrl, async (client) =>
      client.query(`drop database ${name} with (force)`),
    );
  });

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (schemaSql !== undefined) {
    await withClient(url.toString(), async (client) => client.query(schemaSql));
  }
  return url.toString();
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
