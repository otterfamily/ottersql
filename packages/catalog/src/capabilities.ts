import type { PGlite } from "@electric-sql/pglite";

import type { Capabilities } from "./model.ts";

// Since Postgres 10, server_version_num is major * 10000 + minor.
const SERVER_VERSION_NUM_PER_MAJOR = 10_000;

export async function readCapabilities(db: PGlite): Promise<Capabilities> {
  const { rows } = await db.query<{ readonly versionNum: number }>(
    "select current_setting('server_version_num')::int as \"versionNum\"",
  );
  const versionNum = rows[0]?.versionNum;
  if (versionNum === undefined) {
    throw new Error("server_version_num is not set");
  }
  return {
    engine: "postgres",
    version: {
      major: Math.trunc(versionNum / SERVER_VERSION_NUM_PER_MAJOR),
      minor: versionNum % SERVER_VERSION_NUM_PER_MAJOR,
    },
  };
}
