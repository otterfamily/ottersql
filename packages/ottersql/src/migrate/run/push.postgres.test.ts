import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { pgConnection } from "../../sql/pg.ts";
import { applyMigrations, MigrationHistoryError, pushSchema } from "../index.ts";
import { approvalRequired, connect, users } from "../test-migrate.ts";

const withName = "create table users (id int8 primary key, email text, name text)";

async function columns(client: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    "select column_name as name from information_schema.columns where table_name = 'users' order by ordinal_position",
  );
  return rows.map(({ name }) => name);
}

describe("pushSchema", () => {
  test("brings the database to schema.sql directly, recording nothing", async () => {
    const client = await connect(await postgresDatabase(users));
    try {
      const result = await pushSchema(pgConnection(client), withName);
      const { rows } = await client.query("select to_regnamespace('ottersql') as ledger");
      expect({
        applied: result.applied.map(({ kind, object }) => `${kind} ${object}`),
        failed: result.failed,
        manual: result.manual,
        columns: await columns(client),
        rows,
      }).toStrictEqual({
        applied: ["addColumn public.users.name"],
        failed: null,
        manual: [],
        columns: ["id", "email", "name"],
        rows: [{ ledger: null }],
      });
    } finally {
      await client.end();
    }
  });

  test("sets column storage on every supported major, in a new table and a new column", async () => {
    const client = await connect(await postgresDatabase(users));
    try {
      const result = await pushSchema(
        pgConnection(client),
        `create table users (id int8 primary key, email text, note text storage main);
          create table notes (body text storage external)`,
      );
      const { rows } = await client.query(
        "select attrelid::regclass::text as table, attname as column, attstorage as storage from pg_attribute where attname in ('note', 'body') order by 1",
      );
      expect({ failed: result.failed, rows }).toStrictEqual({
        failed: null,
        rows: [
          { table: "notes", column: "body", storage: "e" },
          { table: "users", column: "note", storage: "m" },
        ],
      });
    } finally {
      await client.end();
    }
  });

  test("runs nothing while a change is left to a person", async () => {
    const client = await connect(await postgresDatabase(users));
    try {
      const result = await pushSchema(
        pgConnection(client),
        `${withName}; create function greeting() returns text language sql as 'select 1::text'`,
      );
      expect({
        applied: result.applied,
        manual: result.manual.map(({ object }) => object),
        columns: await columns(client),
      }).toStrictEqual({ applied: [], manual: ["public.greeting"], columns: ["id", "email"] });
    } finally {
      await client.end();
    }
  });

  test("waits for approval before a step that cannot be undone", async () => {
    const client = await connect(await postgresDatabase(withName));
    try {
      const connection = pgConnection(client);
      const refused = await approvalRequired(pushSchema(connection, users));
      const approved = await pushSchema(connection, users, { approve: refused.approval });
      expect({
        refused: refused.steps.map(({ kind, object }) => `${kind} ${object}`),
        approved: approved.applied.map(({ kind }) => kind),
        columns: await columns(client),
      }).toStrictEqual({
        refused: ["dropColumn public.users.name"],
        approved: ["dropColumn"],
        columns: ["id", "email"],
      });
    } finally {
      await client.end();
    }
  });

  test("refuses a database that migrations keep, changing nothing", async () => {
    const client = await connect(await postgresDatabase(users));
    try {
      await applyMigrations(pgConnection(client), []);
      await expect(pushSchema(pgConnection(client), withName)).rejects.toThrow(
        MigrationHistoryError,
      );
      await expect(columns(client)).resolves.toStrictEqual(["id", "email"]);
    } finally {
      await client.end();
    }
  });
});
