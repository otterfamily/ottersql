import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { at, parseJson, project } from "./test-cli.ts";

const bin = fileURLToPath(new URL("bin.ts", import.meta.url));

describe("the ottersql command", () => {
  test("prints the JSON and exits with the code main returns", async () => {
    const root = await project({ "db/schema.sql": "create table users (id int8);\n" });
    const child = spawn(process.execPath, [bin, "migrate", "check", "--json"], { cwd: root });
    const stdout = await text(child.stdout);
    await once(child, "close");
    expect({ status: child.exitCode, code: at(parseJson(stdout), "code") }).toStrictEqual({
      status: 4,
      code: "migrate.out_of_date",
    });
  });
});
