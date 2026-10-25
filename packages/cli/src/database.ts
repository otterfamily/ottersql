import type { Connection } from "@ottersql/sql";
import { pgConnection } from "@ottersql/sql/pg";
import { Client } from "pg";

import type { Context } from "./context.ts";
import { CommandError } from "./outcome.ts";

/**
 * Runs `use` on one session of the database DATABASE_URL names, so that a transaction's statements
 * share a connection. The URL is never shown, since it usually holds a password.
 */
export async function withSession<Result>(
  env: Context["env"],
  use: (connection: Connection) => Promise<Result>,
): Promise<Result> {
  const client = await connect(databaseUrl(env));
  try {
    return await use(pgConnection(client));
  } finally {
    await client.end();
  }
}

function databaseUrl(env: Context["env"]): string {
  const url = env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new CommandError({
      kind: "invalid",
      code: "database.url_missing",
      why: "DATABASE_URL is not set",
      fix: "Set DATABASE_URL to the connection string of the database to migrate",
    });
  }
  return url;
}

async function connect(url: string): Promise<Client> {
  try {
    const client = new Client({ connectionString: url });
    await client.connect();
    return client;
  } catch (error) {
    throw new CommandError({
      kind: "failed",
      code: "database.connection_failed",
      // The driver's messages name the host and the user, never the password.
      why: `Cannot connect to DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Check that the database is running and that DATABASE_URL points to it",
    });
  }
}

const localHosts: ReadonlySet<string> = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuses a DATABASE_URL that is not on this machine: a host name or address elsewhere, rather
 * than localhost, a loopback address or a Unix socket. Names such as a Docker Compose service are
 * refused too, since nothing tells them from a server elsewhere.
 */
export function requireLocal(env: Context["env"], command: string): void {
  const url = URL.parse(databaseUrl(env));
  const host = url === null ? null : (url.searchParams.get("host") ?? url.hostname);
  if (host === null || !(localHosts.has(host) || host.startsWith("/"))) {
    throw new CommandError({
      kind: "invalid",
      code: `${command}.not_local`,
      why: `${command} changes the database directly, without migrations, so it runs only on a database on this machine, and DATABASE_URL points ${host === null ? "to an address it cannot read" : `to ${host}`}`,
      fix: "Change that database through migrations: `ottersql migrate generate <name>` and `ottersql migrate apply`",
    });
  }
}
