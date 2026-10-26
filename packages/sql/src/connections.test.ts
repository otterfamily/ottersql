import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import pgPromise from "pg-promise";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

import { pgPromiseConnection } from "./pg-promise.ts";
import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { postgresJsConnection } from "./postgres-js.ts";

describe("driver adapters", () => {
  test("give one connection per driver object, so its type lookups are kept between calls", async () => {
    const pool = new Pool();
    const db = await PGlite.create();
    const sql = postgres();
    const promised = pgPromise()({});
    try {
      expect(pgConnection(pool)).toBe(pgConnection(pool));
      expect(pgliteConnection(db)).toBe(pgliteConnection(db));
      expect(postgresJsConnection(sql)).toBe(postgresJsConnection(sql));
      expect(pgPromiseConnection(promised)).toBe(pgPromiseConnection(promised));
    } finally {
      await promised.$pool.end();
      await sql.end();
      await pool.end();
      await db.close();
    }
  });

  test("expose no way to run SQL outside typed queries", () => {
    const pool = new Pool();
    expect(pgConnection(pool)).not.toHaveProperty("query");
  });
});
