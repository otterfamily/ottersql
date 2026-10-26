import { postgresDatabase } from "@ottersql/testing";
import { Client, Pool } from "pg";
import { describe, expect, onTestFinished, test } from "vitest";

import { driverConnection, rawQuery } from "./connection.ts";
import { pgDriver } from "./pg-driver.ts";
import { pgConnection } from "./pg.ts";

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

  test("run the transactions of a single client one after the other", async () => {
    const client = new Client({ connectionString: await postgresDatabase() });
    await client.connect();
    onTestFinished(async () => client.end());
    const db = pgConnection(client);
    await rawQuery(db, "create table notes (body text)", []);
    const [failed, kept] = await Promise.allSettled([
      db.transaction(async (tx) => {
        await rawQuery(tx, "insert into notes values ('failed')", []);
        await rawQuery(tx, "select pg_sleep(0.05)", []);
        throw new Error("roll back");
      }),
      db.transaction(async (tx) => rawQuery(tx, "insert into notes values ('kept')", [])),
    ]);
    expect([failed.status, kept.status]).toStrictEqual(["rejected", "fulfilled"]);
    const { rows } = await rawQuery(db, "select body from notes", []);
    expect(rows).toStrictEqual([["kept"]]);
  });
});
