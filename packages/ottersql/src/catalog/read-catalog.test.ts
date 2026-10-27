import { benchmarkSchemaSql } from "@ottersql/testing/benchmark-schema";
import { describe, expect, test } from "vitest";

import { driverConnection, rawQuery, sqlTransaction, transactionModeSql } from "../sql/driver.ts";
import type { DriverQuery } from "../sql/driver.ts";
import type { Connection } from "../sql/index.ts";
import { pgliteConnection } from "../sql/pglite.ts";
import { openSchema, readCatalog } from "./index.ts";

/** `connection`, writing down every statement it sends to the database. */
function recording(connection: Connection): { connection: Connection; statements: string[] } {
  const statements: string[] = [];
  const query: DriverQuery = async (sql, parameters) => {
    statements.push(sql);
    return rawQuery(connection, sql, parameters);
  };
  return {
    statements,
    connection: driverConnection({
      query,
      transaction: async (run, mode) => {
        await query(`begin ${transactionModeSql(mode)}`, []);
        try {
          const result = await run(sqlTransaction(query));
          await query("commit", []);
          return result;
        } catch (error) {
          await query("rollback", []);
          throw error;
        }
      },
    }),
  };
}

describe("readCatalog", () => {
  // Each statement waits a network round trip on a remote database, so the count must not grow
  // with the kinds of objects ottersql reads.
  test("sends five statements: begin, settings, features, the catalog and commit", async () => {
    const schema = await openSchema(benchmarkSchemaSql);
    try {
      const { connection, statements } = recording(pgliteConnection(schema.database));
      expect({
        catalog: await readCatalog(connection),
        statements: statements.length,
      }).toStrictEqual({ catalog: schema.catalog, statements: 5 });
    } finally {
      await schema.close();
    }
  });
});
