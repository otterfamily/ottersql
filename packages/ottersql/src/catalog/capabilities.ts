import { catalogRead, CatalogShapeError, fields, number } from "./catalog-json.ts";
import type { CatalogRead } from "./catalog-json.ts";
import type { Capabilities } from "./model/catalog.ts";

// Since Postgres 10, server_version_num is major * 10000 + minor.
const SERVER_VERSION_NUM_PER_MAJOR = 10_000;

export const capabilitiesRead: CatalogRead<Capabilities> = catalogRead(
  {
    select: "select current_setting('server_version_num')::int as \"versionNum\"",
    row: (value, path) => fields(value, path)("versionNum", number),
    label: "capabilities",
  },
  ([versionNum]) => {
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
  },
);
