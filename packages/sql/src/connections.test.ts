import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import pgPromise from "pg-promise";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

import { pgPromiseConnection } from "./pg-promise.ts";
import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { postgresConnection } from "./postgres.ts";

describe("driver adapters", () => {
  test("give one connection per driver object, so its type lookups are kept between calls", async () => {
    const pool = new Pool();
    const db = await PGlite.create();
    const sql = postgres();
    const promised = pgPromise()({});
    try {
      expect(pgConnection(pool)).toBe(pgConnection(pool));
      expect(pgliteConnection(db)).toBe(pgliteConnection(db));
      expect(postgresConnection(sql)).toBe(postgresConnection(sql));
      expect(pgPromiseConnection(promised)).toBe(pgPromiseConnection(promised));
    } finally {
      await promised.$pool.end();
      await sql.end();
      await pool.end();
      await db.close();
    }
  });
});
