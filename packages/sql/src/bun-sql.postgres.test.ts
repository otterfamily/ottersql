import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { postgresDatabase, runInBun } from "@ottersql/testing";
import { Pool } from "pg";
import { describe, expect, onTestFinished, test } from "vitest";

import { rawQuery } from "./connection.ts";
import { encodeParameter } from "./encode.ts";
import { json } from "./index.ts";
import { pgConnection } from "./pg.ts";

const adapter = JSON.stringify(fileURLToPath(import.meta.resolve("./bun-sql.ts")));
const driver = JSON.stringify(fileURLToPath(import.meta.resolve("./driver.ts")));

/** Statements whose values cover every way Postgres prints the types ottersql decodes. */
const statements = [
  {
    sql: `select 12::int2 as a, 9223372036854775807::int8 as b, 1.10::numeric as c,
      'NaN'::float8 as d, true as e, 'it''s'::text as f,
      '00000000-0000-0000-0000-000000000001'::uuid as g, '0044-03-15 BC'::date as h,
      '2000-01-02 03:04:05.123456'::timestamp as i, '2000-01-02 03:04:05.5+09'::timestamptz as j,
      '23:59:59.999999'::time as k, '1 year 2 mons -3 days 04:05:06.789'::interval as l,
      '\\x0102'::bytea as m, '{"a": [1]}'::jsonb as n, array['a', null]::text[] as o,
      int4range(1, 5) as p, null::int4 as q`,
    parameters: [],
  },
  {
    sql: "select $1::int4 as a, $2::bool as b, $3::bytea as c, $4::timestamptz as d, $5::jsonb as e, $6::text[] as f, $7::int8 as g",
    parameters: [
      41,
      false,
      new Uint8Array([1, 2]),
      Temporal.Instant.from("2026-01-01T00:00:00Z"),
      json({ x: 1 }),
      ["a", null],
      9_007_199_254_740_993n,
    ].map((value) => encodeParameter(value)),
  },
  { sql: "select x from (values (1)) as v (x) where false", parameters: [] },
  { sql: "create temp table nothing (a int)", parameters: [] },
];

function bunScript(url: string, body: string): string {
  return [
    `import { bunSqlConnection } from ${adapter};`,
    `import { rawQuery } from ${driver};`,
    'const { SQL } = require("bun");',
    body.replaceAll("URL", JSON.stringify(url)),
  ].join("\n");
}

/** What a test compares of a rejection: its own fields and message, without the driver's cause. */
function reported(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const { cause: _driverError, ...fields } = error;
  return { ...fields, message: error.message };
}

describe("connections over Bun.sql", () => {
  test("receive exactly the text and types node-postgres receives", async () => {
    const url = await postgresDatabase();
    const pool = new Pool({ connectionString: url });
    const viaPg = [];
    try {
      for (const { sql, parameters } of statements) {
        viaPg.push(await rawQuery(pgConnection(pool), sql, parameters));
      }
    } finally {
      await pool.end();
    }
    const body = `const sql = new SQL(URL, { prepare: false });
      const results = [];
      for (const { sql: text, parameters } of ${JSON.stringify(statements)}) {
        results.push(await rawQuery(bunSqlConnection(sql), text, parameters));
      }
      await sql.end();
      console.log(JSON.stringify(results));`;
    const viaBun: unknown = JSON.parse(await runInBun(bunScript(url, body), tmpdir()));
    expect(viaBun).toStrictEqual(viaPg);
  });

  test("reject with the QueryError node-postgres's connection rejects with", async () => {
    const setup = "create table t (email text not null unique)";
    const failing = "insert into t values ($1), ($1)";
    const pool = new Pool({ connectionString: await postgresDatabase() });
    onTestFinished(async () => pool.end());
    await rawQuery(pgConnection(pool), setup, []);
    const viaPg = await rawQuery(pgConnection(pool), failing, ["otter"]).catch(reported);
    const url = await postgresDatabase();
    const body = `const sql = new SQL(URL, { prepare: false });
      const connection = bunSqlConnection(sql);
      await rawQuery(connection, ${JSON.stringify(setup)}, []);
      const error = await rawQuery(connection, ${JSON.stringify(failing)}, ["otter"]).catch((error) => error);
      await sql.end();
      const { cause: _driverError, ...fields } = error;
      console.log(JSON.stringify({ ...fields, message: error.message }));`;
    const viaBun: unknown = JSON.parse(await runInBun(bunScript(url, body), tmpdir()));
    expect(viaBun).toStrictEqual(viaPg);
    expect(viaPg).toMatchObject({ name: "QueryError", code: "23505" });
  });

  test("run transactions that commit, roll back and keep a savepoint's work apart", async () => {
    const url = await postgresDatabase();
    const body = `const sql = new SQL(URL, { prepare: false });
      const db = bunSqlConnection(sql);
      await rawQuery(db, "create table notes (body text)", []);
      const note = (tx, body) => rawQuery(tx, "insert into notes values ($1)", [body]);
      await db.transaction(async (tx) => {
        await note(tx, "order");
        await tx.savepoint(async (sp) => { await note(sp, "points"); throw new Error("no"); }).catch(() => {});
      });
      await db.transaction(async (tx) => { await note(tx, "draft"); throw new Error("no"); }).catch(() => {});
      const { rows } = await rawQuery(db, "select body from notes", []);
      await sql.end();
      console.log(JSON.stringify(rows));`;
    await expect(runInBun(bunScript(url, body), tmpdir())).resolves.toBe('[["order"]]\n');
  });

  test("refuse a client that prepares statements, whose values may arrive in binary", async () => {
    const url = await postgresDatabase();
    const body = `const sql = new SQL(URL);
      try { bunSqlConnection(sql); } catch (error) { console.log(error.message); }
      await sql.end();`;
    await expect(runInBun(bunScript(url, body), tmpdir())).resolves.toContain("{ prepare: false }");
  });
});
