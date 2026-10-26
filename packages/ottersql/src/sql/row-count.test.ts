import { pglite } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { RowCountError } from "./index.ts";
import { pgliteConnection } from "./pglite.ts";
import { defineQuery } from "./query.ts";

/** What `run` rejected with, as the fields a caller branches on. */
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error instanceof RowCountError
      ? { name: error.name, message: error.message, count: error.count }
      : error;
  }
  throw new TypeError("expected a rejection");
}

const rows = (count: number): string => `select x from generate_series(1, ${String(count)}) as x`;

describe("one and maybeOne", () => {
  test.for([
    { method: "one", count: 0, message: "expected exactly one row, got 0" },
    { method: "one", count: 2, message: "expected exactly one row, got 2" },
    { method: "maybeOne", count: 2, message: "expected at most one row, got 2" },
  ] as const)(
    "$method rejects $count rows with a RowCountError carrying the count",
    async ({ method, count, message }) => {
      const connection = pgliteConnection(await pglite());
      const query = defineQuery(rows(count), []);
      await expect(rejection(query[method](connection))).resolves.toStrictEqual({
        name: "RowCountError",
        message,
        count,
      });
    },
  );

  test("count the rows before decoding them, so a value that cannot be decoded is not the error", async () => {
    const connection = pgliteConnection(await pglite());
    const query = defineQuery("select 'infinity'::date as d from generate_series(1, 2)", []);
    await expect(rejection(query.maybeOne(connection))).resolves.toStrictEqual({
      name: "RowCountError",
      message: "expected at most one row, got 2",
      count: 2,
    });
  });
});
