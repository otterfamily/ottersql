import type { Transaction } from "../sql/index.ts";
import { CatalogShapeError, fields, number, queryRows } from "./catalog-json.ts";

/** What the database the catalog was read from supports. */
export interface Capabilities {
  readonly engine: "postgres";
  readonly version: { readonly major: number; readonly minor: number };
}

// Since Postgres 10, server_version_num is major * 10000 + minor.
const SERVER_VERSION_NUM_PER_MAJOR = 10_000;

export async function readCapabilities(transaction: Transaction): Promise<Capabilities> {
  const [versionNum] = await queryRows(transaction, {
    select: "select current_setting('server_version_num')::int as \"versionNum\"",
    row: (value, path) => fields(value, path)("versionNum", number),
    label: "capabilities",
  });
  if (versionNum === undefined) {
    throw new CatalogShapeError("server_version_num is not set");
  }
  return {
    engine: "postgres",
    version: {
      major: Math.trunc(versionNum / SERVER_VERSION_NUM_PER_MAJOR),
      minor: versionNum % SERVER_VERSION_NUM_PER_MAJOR,
    },
  };
}
