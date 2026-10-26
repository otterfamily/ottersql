import { postgresDatabase } from "@ottersql/testing";
import pgPromise from "pg-promise";
import postgres from "postgres";
import { describe, expect, onTestFinished, test } from "vitest";

import { rawQuery } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { pgPromiseConnection } from "./pg-promise.ts";
import { postgresJsConnection } from "./postgres-js.ts";
import { defineQuery } from "./query.ts";

/** Statements that leave state on a connection, which poolers pin or leak (ADR 0011). */
const sessionState =
  /^\s*(?:create\s+temp|discard\b|listen\b|reset\b|select\s+pg_advisory_lock|set\b)/iv;

/** Runs a transaction with every option, a savepoint and a type lookup on `db`. */
async function exercise(db: Connection): Promise<void> {
  await rawQuery(db, "create type mood as enum ('ok', 'bad')", []);
  await db.transaction(
    async (tx) => {
      await defineQuery("select 'ok'::mood as m", []).one(tx);
      await tx.savepoint(async (sp) => rawQuery(sp, "select 1", []));
    },
    {
      isolation: "serializable",
      readOnly: true,
      deferrable: true,
      settings: { statement_timeout: "5s" },
      retry: { attempts: 2 },
    },
  );
}

describe("what ottersql sends (ADR 0011)", () => {
  test("leaves no session state on postgres.js's connections", async () => {
    const sent: string[] = [];
    const sql = postgres(await postgresDatabase(), {
      debug: (_connection, query) => {
        sent.push(query);
      },
    });
    onTestFinished(async () => sql.end());
    await exercise(postgresJsConnection(sql));
    expect(sent.filter((statement) => sessionState.test(statement))).toStrictEqual([]);
    expect(sent).toContainEqual(expect.stringMatching(/^begin isolation level serializable/v));
  });

  test("leaves no session state on pg-promise's connections", async () => {
    const sent: string[] = [];
    const db = pgPromise({
      query: (event) => {
        sent.push(String(event.query));
      },
    })(await postgresDatabase());
    onTestFinished(async () => db.$pool.end());
    await exercise(pgPromiseConnection(db));
    expect(sent.filter((statement) => sessionState.test(statement))).toStrictEqual([]);
    expect(sent).toContainEqual(expect.stringMatching(/^begin isolation level serializable/iv));
  });
});
