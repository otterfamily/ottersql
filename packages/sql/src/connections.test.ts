import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { postgresConnection } from "./postgres.ts";

describe("driver adapters", () => {
  test("give one connection per driver object, so its type lookups are kept between calls", async () => {
    const pool = new Pool();
    const db = await PGlite.create();
    const sql = postgres();
    try {
      expect(pgConnection(pool)).toBe(pgConnection(pool));
      expect(pgliteConnection(db)).toBe(pgliteConnection(db));
      expect(postgresConnection(sql)).toBe(postgresConnection(sql));
    } finally {
      await sql.end();
      await pool.end();
      await db.close();
    }
  });
});
