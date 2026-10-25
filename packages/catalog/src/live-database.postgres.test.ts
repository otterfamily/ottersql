import { pgConnection } from "@ottersql/sql/pg";
import { postgresDatabase } from "@ottersql/testing";
import { benchmarkSchemaSql } from "@ottersql/testing/benchmark-schema";
import { Client } from "pg";
import { describe, expect, inject, test } from "vitest";

import { loadCatalog, readCatalog } from "./index.ts";

const schemaSql = `${benchmarkSchemaSql};
  create domain email as text not null check (value like '%@%');
  create type span as range (subtype = int8);
  create view open_t0 as select id, code from t0 where status <> 'closed';
  create materialized view t0_count as select count(*) as total from t0;
  alter table t1 add constraint t1_score_positive check (score > 0) not valid;`;

describe("readCatalog", () => {
  test("reads the same catalog through a driver, on every supported major, as from PGlite", async () => {
    const client = new Client({ connectionString: await postgresDatabase(schemaSql) });
    await client.connect();
    try {
      const { capabilities, ...fromDriver } = await readCatalog(pgConnection(client));
      const { capabilities: _pglite, ...fromPglite } = await loadCatalog(schemaSql);
      expect({ major: capabilities.version.major, catalog: fromDriver }).toStrictEqual({
        major: inject("postgresMajor"),
        catalog: fromPglite,
      });
    } finally {
      await client.end();
    }
  });
});
