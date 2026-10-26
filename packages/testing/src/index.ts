import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { GenericContainer, Wait } from "testcontainers";
import { inject, onTestFinished } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Set by the global setup that starts the shared Postgres container. */
    postgresAdminUrl: string;
    /** The major version that container runs. */
    postgresMajor: number;
    /** Where other containers reach that container, as `host:port`. */
    postgresContainerAddress: string;
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

/** The port wsproxy listens on unless told otherwise. */
const WEB_SOCKET_PROXY_PORT = 80;

/** Neon's WebSocket proxy; it is published only as `latest`, so it is pinned by digest. */
const WEB_SOCKET_PROXY_IMAGE =
  "ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb";

/**
 * A WebSocket proxy to the shared Postgres container, as Neon's serverless driver connects
 * through, that runs until `stop` is called. `url` takes the form of the driver's `wsProxy` option:
 * no protocol, and the container's address already appended.
 */
export async function startWebSocketProxy(): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> {
  const address = inject("postgresContainerAddress");
  const container = await new GenericContainer(WEB_SOCKET_PROXY_IMAGE)
    .withEnvironment({ ALLOW_ADDR_REGEX: `^${address.replaceAll(".", String.raw`\.`)}$` })
    .withExposedPorts(WEB_SOCKET_PROXY_PORT)
    .withWaitStrategy(Wait.forLogMessage("Starting server"))
    .start();
  return {
    url: `${container.getHost()}:${String(container.getMappedPort(WEB_SOCKET_PROXY_PORT))}/v1?address=${address}`,
    stop: async () => {
      await container.stop();
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

/**
 * Runs `script` in Bun in `cwd` and returns what it printed; rejects with what it printed to
 * stderr when it fails.
 */
export async function runInBun(script: string, cwd: string): Promise<string> {
  const child = spawn(bunExecutable, ["--eval", script], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "close"),
  ]);
  if (child.exitCode !== 0) {
    throw new Error(`Bun exited with ${String(child.exitCode)}: ${stderr}`);
  }
  return stdout;
}
