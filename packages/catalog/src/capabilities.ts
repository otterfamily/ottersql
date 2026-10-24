import type { PGlite } from "@electric-sql/pglite";

import type { Capabilities } from "./model.ts";

const VERSION_NUM_MAJOR = 10_000;

export async function readCapabilities(db: PGlite): Promise<Capabilities> {
  const { rows } = await db.query<{ readonly versionNum: number }>(
    "select current_setting('server_version_num')::int as \"versionNum\"",
  );
  const versionNum = rows[0]?.versionNum ?? 0;
  return {
    engine: "postgres",
    version: {
      major: Math.trunc(versionNum / VERSION_NUM_MAJOR),
      minor: versionNum % VERSION_NUM_MAJOR,
    },
  };
}
