import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

// Every major ADR 0010 supports, each pinned to a minor version so a new Postgres release cannot
// change test results unannounced.
const images: Readonly<Record<string, string>> = {
  "15": "postgres:15.19-alpine",
  "16": "postgres:16.15-alpine",
  "17": "postgres:17.11-alpine",
  "18": "postgres:18.6-alpine",
};

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The major the shared container runs: OTTERSQL_POSTGRES_MAJOR, or the newest supported one.
  const major = process.env["OTTERSQL_POSTGRES_MAJOR"] ?? "18";
  const image = images[major];
  if (image === undefined) {
    throw new Error(
      `OTTERSQL_POSTGRES_MAJOR is ${major}; supported majors are ${Object.keys(images).join(", ")}`,
    );
  }
  const container = await new PostgreSqlContainer(image).start();
  project.provide("postgresAdminUrl", container.getConnectionUri());
  project.provide("postgresMajor", Number(major));
  return async () => {
    await container.stop();
  };
}
