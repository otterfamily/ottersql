import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import {
  at,
  ottersql,
  ottersqlJson,
  ottersqlJsonWithStderr,
  project,
  writeFiles,
} from "./test-cli.ts";

const users = "create table users (id int8 primary key, email text);\n";

describe("ottersql migrate status", () => {
  test("lists each step and whether it ran, with exit code 0 when the database matches", async () => {
    const url = await postgresDatabase();
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    await writeFiles(root, {
      "db/schema.sql": `${users}create index users_email on users (email);\n`,
    });
    await ottersql(root, ["migrate", "generate", "index_email"]);
    const env = { DATABASE_URL: url };
    await ottersql(root, ["migrate", "apply", "--phase", "expand"], { env });
    await writeFiles(root, {
      "db/schema.sql": `${users}create index users_email on users (email);\ncreate table logs (id int8);\n`,
    });
    await ottersql(root, ["migrate", "generate", "add_logs"]);
    const json = await ottersqlJson(root, ["migrate", "status"], { env });
    const text = await ottersql(root, ["migrate", "status"], { env });
    expect({ json, text }).toStrictEqual({
      json: {
        exitCode: 0,
        json: {
          ok: true,
          command: "migrate status",
          result: {
            steps: [
              {
                migration: "20261025123456_add_users.sql",
                step: 0,
                kind: "createTable",
                object: "public.users",
                phase: "expand",
                applied: true,
              },
              {
                migration: "20261025123457_index_email.sql",
                step: 0,
                kind: "createIndex",
                object: "public.users.users_email",
                phase: "expand",
                applied: true,
              },
              {
                migration: "20261025123458_add_logs.sql",
                step: 0,
                kind: "createTable",
                object: "public.logs",
                phase: "expand",
                applied: false,
              },
            ],
            drift: null,
          },
        },
      },
      text: {
        exitCode: 0,
        stdout: [
          "2 of 3 steps applied; the database matches them",
          "  applied  20261025123456_add_users.sql step 0: expand createTable public.users",
          "  applied  20261025123457_index_email.sql step 0: expand createIndex public.users.users_email",
          "  pending  20261025123458_add_logs.sql step 0: expand createTable public.logs",
          "",
        ].join("\n"),
        stderr: "",
      },
    });
  });

  test("finds what was changed in the database by hand, with exit code 4", async () => {
    const url = await postgresDatabase();
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    const env = { DATABASE_URL: url };
    await ottersql(root, ["migrate", "apply"], { env });
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("alter table users add column note text");
    await client.end();
    await expect(ottersqlJson(root, ["migrate", "status"], { env })).resolves.toStrictEqual({
      exitCode: 4,
      json: {
        ok: false,
        command: "migrate status",
        code: "migrate.drift",
        why: "The database differs from what its applied migrations build: 1 steps and 0 changes left to a person would turn one into the other",
        fix: "Find out who changed the database outside the migrations; put the change in a migration, or undo it in the database",
        result: {
          steps: [
            {
              migration: "20261025123456_add_users.sql",
              step: 0,
              kind: "createTable",
              object: "public.users",
              phase: "expand",
              applied: true,
            },
          ],
          drift: {
            steps: [
              {
                kind: "addColumn",
                object: "public.users.note",
                phase: "expand",
                reversal: "lossy",
                transaction: "inside",
                lock: "access exclusive",
              },
            ],
            manual: [],
          },
        },
      },
    });
  });

  test("reports a statement the database rejects as a failed query, not as a bug", async () => {
    const url = await postgresDatabase(
      "create schema ottersql; create table ottersql.applied_steps (unexpected int4);",
    );
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    const { exitCode, json, stderr } = await ottersqlJsonWithStderr(root, ["migrate", "status"], {
      env: { DATABASE_URL: url },
    });
    expect({
      exitCode,
      code: at(json, "code"),
      sqlstate: at(json, "result", "sqlstate"),
      stack: stderr.includes("    at "),
    }).toStrictEqual({
      exitCode: 1,
      code: "database.query_failed",
      sqlstate: "42703",
      stack: false,
    });
  });
});
