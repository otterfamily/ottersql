import { postgresDatabase } from "@ottersql/testing";
import { Pool } from "pg";
import { describe, expect, onTestFinished, test } from "vitest";

import { driverConnection, rawQuery } from "./connection.ts";
import { pgDriver } from "./pg-driver.ts";

describe("transactions over node-postgres", () => {
  test("send no SET statement, which makes poolers such as RDS Proxy pin the connection", async () => {
    const pool = new Pool({ connectionString: await postgresDatabase() });
    onTestFinished(async () => pool.end());
    const sent: string[] = [];
    const db = driverConnection(
      pgDriver({
        totalCount: pool.totalCount,
        query: async (config) => pool.query({ ...config, values: [...config.values] }),
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (config) => {
              sent.push(config.text);
              return client.query({ ...config, values: [...config.values] });
            },
            release: (destroy) => {
              client.release(destroy);
            },
          };
        },
      }),
    );
    await db.transaction(async (tx) => rawQuery(tx, "select 1", []), {
      isolation: "serializable",
      readOnly: true,
      deferrable: true,
      settings: { statement_timeout: "5s" },
    });
    expect(sent.filter((sql) => /^\s*set\b/iv.test(sql))).toStrictEqual([]);
    expect(sent[0]).toBe("begin isolation level serializable read only deferrable");
  });
});
