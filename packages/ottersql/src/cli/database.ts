import type { Client } from "pg";

import type { Connection } from "../sql/index.ts";
import { pgConnection } from "../sql/pg.ts";
import type { Context } from "./context.ts";
import { CommandError } from "./outcome.ts";

/**
 * Runs `use` on one session of the database DATABASE_URL names, so that a transaction's statements
 * share a connection. The URL is never shown, since it usually holds a password.
 */
export async function withSession<Result>(
  env: Context["env"],
  use: (connection: Connection) => Promise<Result>,
  { onlyLocal }: { readonly onlyLocal?: "push" } = {},
): Promise<Result> {
  const client = new (await nodePostgres())({ connectionString: databaseUrl(env) });
  if (onlyLocal !== undefined) {
    // The host the driver will use, which also comes from PGHOST when the URL names none.
    requireLocal(client.host, onlyLocal);
  }
  await connect(client);
  try {
    return await use(pgConnection(client));
  } finally {
    await client.end();
  }
}

/**
 * The Client of node-postgres, loaded when a command first connects: it is an optional peer dependency
 * (ADR 0013), and commands that read only files run without it.
 */
async function nodePostgres(): Promise<typeof Client> {
  try {
    const pg = await import("pg");
    return pg.default.Client;
  } catch (error) {
    throw new CommandError({
      kind: "invalid",
      code: "database.driver_missing",
      why: `The ottersql command connects with node-postgres (pg), which cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Install it next to ottersql: npm install --save-dev pg",
    });
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

async function connect(client: Client): Promise<void> {
  try {
    await client.connect();
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

const localHosts: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuses a host that is not this machine: a host name or address elsewhere, rather than
 * localhost, a loopback address or a Unix socket. Names such as a Docker Compose service are
 * refused too, since nothing tells them from a server elsewhere.
 */
function requireLocal(host: string, command: "push"): void {
  if (!(localHosts.has(host) || host.startsWith("/"))) {
    throw new CommandError({
      kind: "invalid",
      code: `${command}.not_local`,
      why: `${command} changes the database directly, without migrations, so it runs only on a database on this machine, and DATABASE_URL points to ${host}`,
      fix: "Change that database through migrations: `ottersql migrate generate <name>` and `ottersql migrate apply`",
    });
  }
}
