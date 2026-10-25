import { pgConnection } from "@ottersql/sql/pg";
import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import {
  applyMigrations,
  baselineMigrations,
  migrationStatus,
  planBaseline,
  renderMigration,
} from "./index.ts";
import { connect, users } from "./test-migrate.ts";

const existing = `${users}; create index users_email on users (email)`;
const file = (text: string): { name: string; text: string } => ({
  name: "20261025000000_baseline.sql",
  text,
});

describe("baselineMigrations", () => {
  test("records the steps that build an existing database as applied, running none of them", async () => {
    const client = await connect(await postgresDatabase(existing));
    try {
      const connection = pgConnection(client);
      const baseline = file(renderMigration(await planBaseline(connection)));
      const difference = await baselineMigrations(connection, [baseline]);
      const status = await migrationStatus(connection, [baseline]);
      const applied = await applyMigrations(connection, [baseline]);
      expect({
        difference,
        allApplied: status.steps.every((step) => step.applied),
        drift: status.drift,
        applied: applied.applied,
      }).toStrictEqual({ difference: null, allApplied: true, drift: null, applied: [] });
    } finally {
      await client.end();
    }
  });

  test("records nothing while the files do not build the database, and says what is missing", async () => {
    const client = await connect(
      await postgresDatabase(
        `${users}; create function greeting() returns text language sql as 'select ''hi'''`,
      ),
    );
    try {
      const connection = pgConnection(client);
      const baseline = file(renderMigration(await planBaseline(connection)));
      const difference = await baselineMigrations(connection, [baseline]);
      const { rows } = await client.query("select to_regnamespace('ottersql') as ledger");
      expect({ manual: difference?.manual.map(({ object }) => object), rows }).toStrictEqual({
        manual: ["public.greeting"],
        rows: [{ ledger: null }],
      });
    } finally {
      await client.end();
    }
  });

  test("refuses a database that already ran migrations", async () => {
    const client = await connect(await postgresDatabase(users));
    try {
      const connection = pgConnection(client);
      const baseline = file(renderMigration(await planBaseline(connection)));
      await baselineMigrations(connection, [baseline]);
      await expect(baselineMigrations(connection, [baseline])).rejects.toThrow(
        "The database already ran migrations; a baseline is for one that never did",
      );
    } finally {
      await client.end();
    }
  });
});
