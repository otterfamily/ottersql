import { postgresDatabase } from "@ottersql/testing";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { at, ottersql, ottersqlJson, parseJson, project, writeFiles } from "./test-cli.ts";

const users = "create table users (id int8 primary key, email text);\n";
const withoutEmail = "create table users (id int8 primary key);\n";
const migration = "db/migrations/20261025123456_add_users.sql";

async function columns(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      "select column_name as name from information_schema.columns where table_name = 'users' order by ordinal_position",
    );
    return rows.map(({ name }) => name);
  } finally {
    await client.end();
  }
}

/** A project whose migrations create users, then drop its email column. */
async function droppingEmail(): Promise<string> {
  const root = await project({ "db/schema.sql": users });
  await ottersql(root, ["migrate", "generate", "add_users"]);
  await writeFiles(root, { "db/schema.sql": withoutEmail });
  await ottersql(root, ["migrate", "generate", "drop_email"]);
  return root;
}

describe("ottersql migrate apply", () => {
  test("applies the pending steps to DATABASE_URL, and nothing the second time", async () => {
    const url = await postgresDatabase();
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    const env = { DATABASE_URL: url };
    const first = await ottersqlJson(root, ["migrate", "apply"], { env });
    const second = await ottersqlJson(root, ["migrate", "apply"], { env });
    expect({ first, second, columns: await columns(url) }).toStrictEqual({
      first: {
        exitCode: 0,
        json: {
          ok: true,
          command: "migrate apply",
          result: {
            applied: [{ migration: "20261025123456_add_users.sql", step: 0 }],
            waiting: null,
          },
        },
      },
      second: {
        exitCode: 0,
        json: { ok: true, command: "migrate apply", result: { applied: [], waiting: null } },
      },
      columns: ["id", "email"],
    });
  });

  test("stops before a step that cannot be undone, with exit code 3, until it is approved", async () => {
    const url = await postgresDatabase();
    const root = await droppingEmail();
    const env = { DATABASE_URL: url };
    const refused = await ottersqlJson(root, ["migrate", "apply"], { env });
    const before = await columns(url);
    const approval = String(at(refused.json, "result", "approval"));
    const approved = await ottersqlJson(root, ["migrate", "apply", "--approve", approval], { env });
    expect({
      refused,
      before,
      approved: approved.exitCode,
      after: await columns(url),
    }).toStrictEqual({
      refused: {
        exitCode: 3,
        json: {
          ok: false,
          command: "migrate apply",
          code: "migrate.approval_required",
          why: "1 pending steps cannot be undone",
          fix: `Review the steps, then run \`ottersql migrate apply --approve ${approval}\``,
          result: {
            approval,
            steps: [
              {
                migration: "20261025123457_drop_email.sql",
                step: 0,
                kind: "dropColumn",
                object: "public.users.email",
              },
            ],
          },
        },
      },
      before: [],
      approved: 0,
      after: ["id"],
    });
  });

  test("leaves the approval to a person when an agent runs it", async () => {
    const url = await postgresDatabase();
    const root = await droppingEmail();
    const env = { DATABASE_URL: url };
    const asked = await ottersqlJson(root, ["migrate", "apply"], { env, agent: "claude" });
    const approving = await ottersqlJson(root, ["migrate", "apply", "--approve", "anything"], {
      env,
      agent: "claude",
    });
    expect({
      asked: [asked.exitCode, at(asked.json, "code"), at(asked.json, "fix")],
      approving,
      columns: await columns(url),
    }).toStrictEqual({
      asked: [
        3,
        "migrate.approval_required",
        `Show the steps to the user and ask them to run \`ottersql migrate apply --approve ${String(at(asked.json, "result", "approval"))}\` in their own terminal; an agent cannot approve them`,
      ],
      approving: {
        exitCode: 3,
        json: {
          ok: false,
          command: "migrate apply",
          code: "migrate.approval_by_agent",
          why: "claude is an AI agent, and only a person can approve steps that cannot be undone",
          fix: "Show the steps to the user and ask them to run the command with --approve in their own terminal",
        },
      },
      columns: [],
    });
  });

  test("runs one phase with --phase, and names the step that waits for the other", async () => {
    const url = await postgresDatabase();
    const root = await droppingEmail();
    const env = { DATABASE_URL: url };
    const json = await ottersqlJson(root, ["migrate", "apply", "--phase", "expand"], { env });
    const text = await ottersql(root, ["migrate", "apply", "--phase", "expand"], { env });
    expect({ json, text }).toStrictEqual({
      json: {
        exitCode: 0,
        json: {
          ok: true,
          command: "migrate apply",
          result: {
            applied: [{ migration: "20261025123456_add_users.sql", step: 0 }],
            waiting: { migration: "20261025123457_drop_email.sql", step: 0, phase: "contract" },
          },
        },
      },
      text: {
        exitCode: 0,
        stdout:
          "Applied 0 steps\nNext: 20261025123457_drop_email.sql step 0 runs with --phase contract\n",
        stderr: "",
      },
    });
  });

  test("reports a step the database rejects, with its SQLSTATE and exit code 1", async () => {
    const url = await postgresDatabase("create table users (id int8)");
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    await expect(
      ottersqlJson(root, ["migrate", "apply"], { env: { DATABASE_URL: url } }),
    ).resolves.toStrictEqual({
      exitCode: 1,
      json: {
        ok: false,
        command: "migrate apply",
        code: "migrate.step_failed",
        why: 'Step 0 of 20261025123456_add_users.sql failed: relation "users" already exists (SQLSTATE 42P07)',
        fix: "Fix the cause, then apply again; it resumes at this step",
        where: { file: migration },
        result: {
          applied: [],
          failed: {
            migration: "20261025123456_add_users.sql",
            step: 0,
            sqlstate: "42P07",
            message: 'relation "users" already exists',
          },
        },
      },
    });
  });

  test("refuses a migration edited after it was applied, with exit code 2", async () => {
    const url = await postgresDatabase();
    const root = await project({ "db/schema.sql": users });
    await ottersql(root, ["migrate", "generate", "add_users"]);
    const env = { DATABASE_URL: url };
    await ottersql(root, ["migrate", "apply"], { env });
    await writeFiles(root, {
      [migration]:
        '-- ottersql:step kind=createTable object="public.users" phase=expand reversal=lossy transaction=inside lock="none"\ncreate table users (id int8);\n',
    });
    await expect(ottersqlJson(root, ["migrate", "apply"], { env })).resolves.toMatchObject({
      exitCode: 2,
      json: { ok: false, code: "migrate.history_mismatch" },
    });
  });

  test("refuses a migration file it cannot read, before running any step", async () => {
    const url = await postgresDatabase();
    const root = await project({
      "db/schema.sql": users,
      [migration]: "create table users (id int8);\n",
    });
    await expect(
      ottersqlJson(root, ["migrate", "apply"], { env: { DATABASE_URL: url } }),
    ).resolves.toStrictEqual({
      exitCode: 2,
      json: {
        ok: false,
        command: "migrate apply",
        code: "migrate.file_invalid",
        why: "20261025123456_add_users.sql line 1: SQL must follow a -- ottersql:step line",
        fix: "Fix the migration file; each step's SQL follows a `-- ottersql:step` line",
        where: { file: migration, line: 1 },
      },
    });
  });

  test.for([
    { label: "no DATABASE_URL", env: {}, code: "database.url_missing", exitCode: 2 },
    {
      label: "a database it cannot reach",
      env: { DATABASE_URL: "postgres://otter:hunter2@127.0.0.1:1/nowhere" },
      code: "database.connection_failed",
      exitCode: 1,
    },
  ])("reports $label, never printing the connection string", async ({ env, code, exitCode }) => {
    const root = await project({ "db/schema.sql": users });
    const run = await ottersql(root, ["migrate", "apply", "--json"], { env });
    expect({
      exitCode: run.exitCode,
      json: parseJson(run.stdout),
      leaks: `${run.stdout}${run.stderr}`.includes("hunter2"),
    }).toMatchObject({ exitCode, json: { ok: false, code }, leaks: false });
  });
});
