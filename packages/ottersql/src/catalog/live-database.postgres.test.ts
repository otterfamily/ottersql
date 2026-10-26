import { postgresDatabase } from "@ottersql/testing";
import { benchmarkSchemaSql } from "@ottersql/testing/benchmark-schema";
import { Client } from "pg";
import { describe, expect, inject, test } from "vitest";

import { pgConnection } from "../sql/pg.ts";
import { loadCatalog, readCatalog } from "./index.ts";

const schemaSql = `${benchmarkSchemaSql};
  create domain email as text not null check (value like '%@%');
  create type span as range (subtype = int8);
  create view open_t0 as select id, code from t0 where status <> 'closed';
  create materialized view t0_count as select count(*) as total from t0;
  alter table t1 add constraint t1_score_positive check (score > 0) not valid;
  create schema app;
  create extension citext;
  create sequence app.tickets increment by 2;
  create table app.notes (id int8 primary key, body text collate "C", owner text);
  create function app.touch() returns trigger language plpgsql as 'begin return new; end';
  create function app.twice(n int) returns int language sql immutable return n * 2;
  create trigger notes_touch before update on app.notes for each row execute function app.touch();
  alter table app.notes enable row level security;
  create policy own on app.notes for select using (owner = current_user);
  create table events (id int8, at date) partition by range (at);
  create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');`;

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
