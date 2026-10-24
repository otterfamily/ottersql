import { createPostgresDatabase } from "@ottersql/testing";
import { Pool } from "pg";
import { describe, test } from "vitest";

import { pgConnection } from "./pg.ts";
import { defineQuery } from "./query.ts";

const ROWS = 1000;

// Columns of the types applications read most, decoded by pg's parsers or ottersql's codecs.
const sql = `select n::int8 as id, n::int4 as count, 'name ' || n as name, n % 2 = 0 as flag,
    timestamptz '2026-01-01' + n * interval '1 minute' as at, n / 7.0 as amount,
    jsonb_build_object('n', n) as data, array['a', 'b'] as tags
  from generate_series(1, ${String(ROWS)}) as n`;

describe("running a query", () => {
  test(`overhead of decoding ${String(ROWS)} rows of common types`, async ({ bench }) => {
    const database = await createPostgresDatabase();
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      const connection = pgConnection(pool);
      const query = defineQuery(sql, []);
      await bench("node-postgres with its own parsers", async () => {
        await pool.query(sql);
      }).run({ iterations: 200, time: 0 });
      await bench("ottersql over node-postgres", async () => {
        await query(connection);
      }).run({ iterations: 200, time: 0 });
    } finally {
      await pool.end();
      await database.drop();
    }
  });
});
