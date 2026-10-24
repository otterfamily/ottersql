import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";

import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";

describe("driver adapters", () => {
  test("give one connection per driver object, so its type lookups are kept between calls", async () => {
    const pool = new Pool();
    const db = await PGlite.create();
    try {
      expect(pgConnection(pool)).toBe(pgConnection(pool));
      expect(pgliteConnection(db)).toBe(pgliteConnection(db));
    } finally {
      await pool.end();
      await db.close();
    }
  });
});
