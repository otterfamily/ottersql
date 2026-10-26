import { postgresDatabase } from "@ottersql/testing";
import pgPromise from "pg-promise";
import { describe, expect, onTestFinished, test } from "vitest";

import { pgPromiseConnection } from "./pg-promise.ts";

describe("pg-promise connections", () => {
  test("send parameters for Postgres to bind, rather than formatting them into the SQL", async () => {
    const db = pgPromise()(await postgresDatabase());
    onTestFinished(async () => db.$pool.end());
    const result = await pgPromiseConnection(db).query("select '$1' as literal, $1 as bound", [
      "value",
    ]);
    expect(result.rows).toStrictEqual([["$1", "value"]]);
  });
});
