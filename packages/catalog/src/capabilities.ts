import type { Connection } from "@ottersql/sql";

import { fields, number, queryRows } from "./catalog-json.ts";
import type { Capabilities } from "./model.ts";

// Since Postgres 10, server_version_num is major * 10000 + minor.
const SERVER_VERSION_NUM_PER_MAJOR = 10_000;

export async function readCapabilities(connection: Connection): Promise<Capabilities> {
  const [versionNum] = await queryRows(connection, {
    select: "select current_setting('server_version_num')::int as \"versionNum\"",
    row: (value, path) => fields(value, path)("versionNum", number),
    label: "capabilities",
  });
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
