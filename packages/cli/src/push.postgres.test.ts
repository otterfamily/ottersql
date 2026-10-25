import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { at, ottersqlJson, project } from "./test-cli.ts";

const users = "create table users (id int8 primary key, email text);\n";
const withName = "create table users (id int8 primary key, email text, name text);\n";

describe("ottersql push", () => {
  test("brings a database on this machine to schema.sql, without migrations", async () => {
    const env = { DATABASE_URL: await postgresDatabase(users) };
    const root = await project({ "db/schema.sql": withName });
    await expect(ottersqlJson(root, ["push"], { env })).resolves.toStrictEqual({
      exitCode: 0,
      json: {
        ok: true,
        command: "push",
        result: {
          applied: [
            {
              kind: "addColumn",
              object: "public.users.name",
              phase: "expand",
              reversal: "lossy",
              transaction: "inside",
              lock: "access exclusive",
            },
          ],
        },
      },
    });
  });

  test.for([
    "postgres://otter:hunter2@db.example.com/app",
    "postgres://otter@10.0.0.5:5432/app",
    "postgres://otter@db/app",
  ])("refuses a database elsewhere, %s, before connecting", async (url) => {
    const root = await project({ "db/schema.sql": withName });
    const { exitCode, json } = await ottersqlJson(root, ["push"], { env: { DATABASE_URL: url } });
    expect({ exitCode, code: at(json, "code") }).toStrictEqual({
      exitCode: 2,
      code: "push.not_local",
    });
  });

  test("runs nothing while a change is left to a person, with exit code 4", async () => {
    const env = { DATABASE_URL: await postgresDatabase(users) };
    const root = await project({
      "db/schema.sql": `${withName}create function greeting() returns text language sql as 'select 1::text';\n`,
    });
    const { exitCode, json } = await ottersqlJson(root, ["push"], { env });
    expect({
      exitCode,
      code: at(json, "code"),
      manual: at(json, "result", "manual"),
    }).toStrictEqual({
      exitCode: 4,
      code: "push.manual",
      manual: [
        {
          object: "public.greeting",
          reason: "ottersql does not plan changes to a function yet; write this change by hand",
        },
      ],
    });
  });

  test("leaves dropping a column to a person when an agent runs it", async () => {
    const env = { DATABASE_URL: await postgresDatabase(withName) };
    const root = await project({ "db/schema.sql": users });
    const { exitCode, json } = await ottersqlJson(root, ["push"], { env, agent: "claude" });
    expect({ exitCode, code: at(json, "code"), fix: String(at(json, "fix")) }).toStrictEqual({
      exitCode: 3,
      code: "push.approval_required",
      fix: `Show the steps to the user and ask them to run \`ottersql push --approve ${String(at(json, "result", "approval"))}\` in their own terminal; an agent cannot approve them`,
    });
  });
});
