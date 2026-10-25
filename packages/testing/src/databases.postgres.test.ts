import { Client } from "pg";
import type { QueryResultRow } from "pg";
import { describe, expect, inject, test } from "vitest";

import { createPostgresDatabase, pglite, postgresDatabase } from "./index.ts";

const schema = `
  create table users (id int primary key, name text not null);
  insert into users values (1, 'alice');
`;

async function queryOnce<Row extends QueryResultRow>(url: string, sql: string): Promise<Row[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<Row>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

describe("pglite", () => {
  test("applies the schema and answers queries", async () => {
    const db = await pglite(schema);
    const { rows } = await db.query<{ name: string }>("select name from users where id = 1");
    expect(rows).toStrictEqual([{ name: "alice" }]);
  });
});

describe("postgresDatabase", () => {
  test("applies the schema to a fresh database on the Postgres major the run asked for", async () => {
    const url = await postgresDatabase(schema);
    const rows = await queryOnce<{ name: string; major: number }>(
      url,
      "select name, current_setting('server_version_num')::int / 10000 as major from users",
    );
    expect(rows).toStrictEqual([{ name: "alice", major: inject("postgresMajor") }]);
  });

  test("gives each test its own database", async () => {
    const withUsers = await postgresDatabase(schema);
    const empty = await postgresDatabase();
    expect(withUsers).not.toBe(empty);
    const tables = await queryOnce<{ count: string }>(
      empty,
      "select count(*) from information_schema.tables where table_schema = 'public'",
    );
    expect(tables).toStrictEqual([{ count: "0" }]);
  });

  test("keeps a database made for a shared fixture until it is dropped", async () => {
    const database = await createPostgresDatabase(schema);
    const before = await queryOnce<{ name: string }>(database.url, "select name from users");
    await database.drop();
    await expect(queryOnce(database.url, "select 1")).rejects.toThrow("does not exist");
    expect(before).toStrictEqual([{ name: "alice" }]);
  });
});
