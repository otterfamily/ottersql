import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

// Pinned to a minor version so a new Postgres release cannot change test results unannounced.
const POSTGRES_IMAGE = "postgres:18.6-alpine";

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  project.provide("postgresAdminUrl", container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
