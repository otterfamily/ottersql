import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { at, ottersql, ottersqlJson, project, writeFiles } from "./test-cli.ts";

const users = "create table users (id int8 primary key, email text);\n";
const createUsers = {
  kind: "createTable",
  object: "public.users",
  phase: "expand",
  reversal: "lossy",
  transaction: "inside",
  lock: "none",
};

describe("ottersql migrate generate", () => {
  test("writes what schema.sql adds as the next migration, named by UTC time, next to the schema", async () => {
    const root = await project({ "db/schema.sql": users });
    const generated = await ottersqlJson(root, ["migrate", "generate", "add_users"]);
    expect({
      generated,
      files: await readdir(join(root, "db", "migrations")),
      check: await ottersqlJson(root, ["migrate", "check"]),
    }).toStrictEqual({
      generated: {
        exitCode: 0,
        json: {
          ok: true,
          command: "migrate generate",
          result: {
            file: "db/migrations/20261025123456_add_users.sql",
            steps: [createUsers],
            manual: [],
          },
        },
      },
      files: ["20261025123456_add_users.sql"],
      check: { exitCode: 0, json: { ok: true, command: "migrate check", result: {} } },
    });
  });

  test("writes nothing when the migrations already build schema.sql", async () => {
    const root = await project({ "db/schema.sql": "" });
    await expect(ottersqlJson(root, ["migrate", "generate", "nothing"])).resolves.toStrictEqual({
      exitCode: 0,
      json: {
        ok: true,
        command: "migrate generate",
        result: { file: null, steps: [], manual: [] },
      },
    });
  });

  test("lists the changes it leaves to a person, and still writes the steps it planned", async () => {
    const root = await project({ "db/schema.sql": users });
    await ottersqlJson(root, ["migrate", "generate", "add_users"]);
    await writeFiles(root, {
      "db/schema.sql":
        "create table users (id int8 primary key, email text, created uuid default gen_random_uuid());\n",
    });
    const { json } = await ottersqlJson(root, ["migrate", "generate", "add_created"]);
    expect(json).toMatchObject({
      ok: true,
      result: { steps: [], manual: [{ object: "public.users.created" }] },
    });
  });

  test("writes a file for steps written by hand with --empty, whatever schema.sql says", async () => {
    const root = await project({ "db/schema.sql": users });
    const generated = await ottersqlJson(root, ["migrate", "generate", "backfill", "--empty"]);
    const text = await readFile(join(root, "db/migrations/20261025123456_backfill.sql"), "utf8");
    const checked = await ottersqlJson(root, ["migrate", "check"]);
    expect({
      generated,
      startsWith: text.split("\n")[0],
      checked: at(checked.json, "code"),
    }).toStrictEqual({
      generated: {
        exitCode: 0,
        json: {
          ok: true,
          command: "migrate generate",
          result: { file: "db/migrations/20261025123456_backfill.sql", steps: [], manual: [] },
        },
      },
      startsWith: "-- Steps written by hand. Each starts with a line such as",
      checked: "migrate.out_of_date",
    });
  });

  test("finds the schema where the tsconfig's content mapper looks for it", async () => {
    const root = await project({
      "tsconfig.json": `{
        // comments and trailing commas, as tsconfig allows
        "contentMappers": [
          { "package": "ottersql", "extensions": [".sql"], "options": { "schema": "sql/schema.sql" } },
        ],
      }`,
      "sql/schema.sql": users,
    });
    const { json } = await ottersqlJson(root, ["migrate", "generate", "add_users"]);
    expect(json).toMatchObject({
      result: { file: "sql/migrations/20261025123456_add_users.sql" },
    });
  });
});

describe("ottersql migrate check", () => {
  test("finds the steps the migrations miss, with exit code 4", async () => {
    const root = await project({ "db/schema.sql": "" });
    await writeFiles(root, { "db/schema.sql": users });
    await expect(ottersqlJson(root, ["migrate", "check"])).resolves.toStrictEqual({
      exitCode: 4,
      json: {
        ok: false,
        command: "migrate check",
        code: "migrate.out_of_date",
        why: "The migrations do not build db/schema.sql: 1 steps and 0 changes left to a person are missing",
        fix: "Run `ottersql migrate generate <name>` and review the migration it writes",
        result: { steps: [createUsers], manual: [] },
      },
    });
  });

  test("refuses a migration file it cannot read, naming the file", async () => {
    const root = await project({
      "db/schema.sql": users,
      "db/migrations/20261025000000_hand.sql": "create table users (id int8);\n",
    });
    await expect(ottersqlJson(root, ["migrate", "check"])).resolves.toStrictEqual({
      exitCode: 2,
      json: {
        ok: false,
        command: "migrate check",
        code: "migrate.file_invalid",
        why: "20261025000000_hand.sql line 1: SQL must follow a -- ottersql:step line",
        fix: "Fix the migration file; each step's SQL follows a `-- ottersql:step` line",
        where: { file: "db/migrations/20261025000000_hand.sql", line: 1 },
      },
    });
  });

  test("reports an error in schema.sql at its line", async () => {
    const root = await project({ "db/schema.sql": "\ncreate table users (id int8;\n" });
    const { exitCode, json } = await ottersqlJson(root, ["migrate", "check"]);
    expect({ exitCode, json }).toMatchObject({
      exitCode: 2,
      json: {
        ok: false,
        code: "schema.invalid",
        where: { file: "db/schema.sql", line: 2 },
      },
    });
  });

  test("reports a missing schema.sql", async () => {
    const root = await project({});
    await expect(ottersqlJson(root, ["migrate", "check"])).resolves.toMatchObject({
      exitCode: 2,
      json: { ok: false, code: "schema.unreadable", where: { file: "db/schema.sql" } },
    });
  });
});

describe("ottersql arguments", () => {
  test.for([
    { args: [], why: "Name a command" },
    { args: ["migrate"], why: "Name a command" },
    { args: ["migrate", "push"], why: "Unknown command: migrate push" },
    { args: ["migrate", "generate"], why: "Name the migration, such as `add_users`" },
    {
      args: ["migrate", "generate", "Add Users"],
      why: 'A migration name is lowercase letters, digits and underscores, not "Add Users"',
    },
    {
      args: ["migrate", "apply", "--phase", "later"],
      why: '--phase is expand or contract, not "later"',
    },
    { args: ["migrate", "check", "--phase", "expand"], why: "migrate check takes no --phase" },
    { args: ["migrate", "check", "--force"], why: "Unknown option '--force'" },
    { args: ["migrate", "apply", "--empty"], why: "migrate apply takes no --empty" },
  ])("refuses $args with exit code 2", async ({ args, why }) => {
    const root = await project({});
    const { exitCode, json } = await ottersqlJson(root, args);
    expect({
      exitCode,
      code: at(json, "code"),
      explains: String(at(json, "why")).includes(why),
    }).toStrictEqual({ exitCode: 2, code: "usage.invalid", explains: true });
  });

  test("prints for people without --json: results on stdout, errors on stderr", async () => {
    const root = await project({ "db/schema.sql": users });
    const generated = await ottersql(root, ["migrate", "generate", "add_users"]);
    await writeFiles(root, { "db/schema.sql": `${users}create table logs (id int8);\n` });
    const checked = await ottersql(root, ["migrate", "check"]);
    expect({ generated, checked }).toStrictEqual({
      generated: {
        exitCode: 0,
        stdout:
          "Wrote db/migrations/20261025123456_add_users.sql with 1 steps:\n  expand createTable public.users (lossy, inside, lock none)\n",
        stderr: "",
      },
      checked: {
        exitCode: 4,
        stdout: "",
        stderr:
          "The migrations do not build db/schema.sql: 1 steps and 0 changes left to a person are missing\n  expand createTable public.logs (lossy, inside, lock none)\nFix: Run `ottersql migrate generate <name>` and review the migration it writes\n",
      },
    });
  });

  test("explains itself with --help", async () => {
    const root = await project({});
    const { exitCode, stdout } = await ottersql(root, ["--help"]);
    expect({ exitCode, mentionsApply: stdout.includes("ottersql migrate apply") }).toStrictEqual({
      exitCode: 0,
      mentionsApply: true,
    });
  });
});
