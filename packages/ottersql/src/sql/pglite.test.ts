import { PGlite } from "@electric-sql/pglite";
import { describe, expect, onTestFinished, test } from "vitest";

import { rawQuery } from "./connection.ts";
import { pgliteConnection } from "./pglite.ts";
import { defineQuery } from "./query.ts";

async function database(): Promise<PGlite> {
  const db = await PGlite.create();
  onTestFinished(async () => db.close());
  return db;
}

describe("connections over PGlite", () => {
  test("receive every value as text, after the schema changes a column's type", async () => {
    const db = await database();
    const connection = pgliteConnection(db);
    await db.exec("create table t (x int4); insert into t values (7)");
    const read = defineQuery("select x from t", []);
    await expect(read.one(connection)).resolves.toStrictEqual({ x: 7 });
    await db.exec("alter table t alter column x type int8");
    await expect(read.one(connection)).resolves.toStrictEqual({ x: "7" });
  });

  test("receive arrays of types created after connecting as text", async () => {
    const db = await database();
    const connection = pgliteConnection(db);
    await db.exec("create type mood as enum ('ok', 'bad')");
    await db.refreshArrayTypes();
    const { rows } = await rawQuery(connection, "select array['ok', 'bad']::mood[]", []);
    expect(rows).toStrictEqual([["{ok,bad}"]]);
  });
});
