import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { at, ottersqlJson, project } from "./test-cli.ts";

const users = "create table users (id int8 primary key, email text)";
const greeting = "create function greeting() returns text language sql as 'select ''hi'''";
const file = "db/migrations/20261025123456_baseline.sql";

describe("ottersql migrate baseline", () => {
  test("writes the first migration from an existing database and records it as applied", async () => {
    const env = { DATABASE_URL: await postgresDatabase(users) };
    const root = await project({ "db/schema.sql": `${users};\n` });
    const baseline = await ottersqlJson(root, ["migrate", "baseline", "baseline"], { env });
    const status = await ottersqlJson(root, ["migrate", "status"], { env });
    expect({
      baseline,
      status: [status.exitCode, at(status.json, "result", "drift")],
    }).toStrictEqual({
      baseline: {
        exitCode: 0,
        json: { ok: true, command: "migrate baseline", result: { file, recorded: 1 } },
      },
      status: [0, null],
    });
  });

  test("leaves what it cannot plan to be written by hand, and records once the file builds the database", async () => {
    const env = { DATABASE_URL: await postgresDatabase(`${users}; ${greeting}`) };
    const root = await project({ "db/schema.sql": `${users};\n${greeting};\n` });
    const first = await ottersqlJson(root, ["migrate", "baseline", "baseline"], { env });
    await appendFile(
      join(root, file),
      `\n-- ottersql:step kind=custom object="public.greeting" phase=expand reversal=lossy lock="none"\n${greeting};\n`,
    );
    const second = await ottersqlJson(root, ["migrate", "baseline"], { env });
    expect({
      first: [
        first.exitCode,
        at(first.json, "code"),
        at(first.json, "result", "difference", "manual"),
      ],
      second,
    }).toStrictEqual({
      first: [
        4,
        "migrate.baseline_mismatch",
        [
          {
            object: "public.greeting",
            reason: "ottersql does not plan changes to a function yet; write this change by hand",
          },
        ],
      ],
      second: {
        exitCode: 0,
        json: { ok: true, command: "migrate baseline", result: { file: null, recorded: 2 } },
      },
    });
  });
});
