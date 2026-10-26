import { describe, expect, test } from "vitest";

import { openSchema } from "../catalog/index.ts";
import { pgliteConnection } from "../sql/pglite.ts";
import { applyMigrations } from "./index.ts";
import { approvalRequired, migrationFrom, step, users } from "./test-migrate.ts";

describe("applyMigrations approval", () => {
  test("runs nothing while a pending step cannot be undone, until those pending steps are approved", async () => {
    const schema = await openSchema(users);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, "create table users (id int8 primary key)");
      const refused = await approvalRequired(applyMigrations(connection, [file]));
      const approved = await applyMigrations(connection, [file], { approve: refused.approval });
      expect({ steps: refused.steps, approved }).toStrictEqual({
        steps: [{ ...step(file.name, 0), kind: "dropColumn", object: "public.users.email" }],
        approved: { applied: [step(file.name, 0)], failed: null, waiting: null },
      });
    } finally {
      await schema.close();
    }
  });

  test("refuses an approval given for other pending steps", async () => {
    const schema = await openSchema(users);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, "create table users (id int8 primary key)");
      const seen = await approvalRequired(applyMigrations(connection, [file]));
      const another = await migrationFrom(
        "create table users (id int8 primary key)",
        "create table users (id int8 primary key); create table logs (id int8)",
        "20261026000000_logs.sql",
      );
      const refused = await approvalRequired(
        applyMigrations(connection, [file, another], { approve: seen.approval }),
      );
      const after = await schema.readCatalog();
      expect({
        changed: refused.approval !== seen.approval,
        columns: after.tables.flatMap(({ columns }) => columns.map(({ name }) => name)),
      }).toStrictEqual({ changed: true, columns: ["id", "email"] });
    } finally {
      await schema.close();
    }
  });

  test("needs no approval for steps that can be undone", async () => {
    const schema = await openSchema(users);
    try {
      const connection = pgliteConnection(schema.database);
      const file = await migrationFrom(users, `${users}; create index on users (email)`);
      await expect(applyMigrations(connection, [file])).resolves.toStrictEqual({
        applied: [step(file.name, 0)],
        failed: null,
        waiting: null,
      });
    } finally {
      await schema.close();
    }
  });
});
