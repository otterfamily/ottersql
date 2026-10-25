import { pgConnection } from "@ottersql/sql/pg";
import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { applyMigrations, migrationStatus } from "./index.ts";
import { connect, migrationFrom, users } from "./test-migrate.ts";

describe("migrationStatus", () => {
  test("says which steps ran, writing nothing to a database that never ran any", async () => {
    const client = await connect(await postgresDatabase(""));
    try {
      const file = await migrationFrom("", users);
      const status = await migrationStatus(pgConnection(client), [file]);
      const { rows } = await client.query("select to_regnamespace('ottersql') as ledger");
      expect({ status, rows }).toStrictEqual({
        status: {
          steps: [
            {
              migration: file.name,
              step: 0,
              kind: "createTable",
              object: "public.users",
              phase: "expand",
              applied: false,
            },
          ],
          drift: null,
        },
        rows: [{ ledger: null }],
      });
    } finally {
      await client.end();
    }
  });

  test("finds what was changed in the database by hand, apart from the migrations", async () => {
    const url = await postgresDatabase("");
    const client = await connect(url);
    try {
      const create = await migrationFrom("", users, "20261025000000_users.sql");
      const connection = pgConnection(client);
      await applyMigrations(connection, [create]);
      await client.query("alter table users add column note text");
      const status = await migrationStatus(connection, [create]);
      expect({
        steps: status.steps,
        drift: status.drift?.steps.map(({ kind, object }) => `${kind} ${object}`),
      }).toStrictEqual({
        steps: [
          {
            migration: create.name,
            step: 0,
            kind: "createTable",
            object: "public.users",
            phase: "expand",
            applied: true,
          },
        ],
        drift: ["addColumn public.users.note"],
      });
    } finally {
      await client.end();
    }
  });
});
