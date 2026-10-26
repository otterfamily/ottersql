import { describe, expect, test as base } from "vitest";

import { rawQuery } from "./connection.ts";
import type { Connection, Transaction } from "./connection.ts";
import { QueryError } from "./query-error.ts";
import { openDrivers } from "./test-drivers.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

/** A fresh `notes` table on the database behind `connection`. */
async function notes(connection: Connection): Promise<void> {
  await rawQuery(connection, "drop table if exists notes", []);
  await rawQuery(connection, "create table notes (body text primary key)", []);
}

async function note(connection: Connection | Transaction, body: string): Promise<void> {
  await rawQuery(connection, "insert into notes (body) values ($1)", [body]);
}

async function bodies(connection: Connection | Transaction): Promise<unknown[]> {
  const { rows } = await rawQuery(connection, "select body from notes order by body", []);
  return rows.map(([body]) => body);
}

async function setting(connection: Connection | Transaction, name: string): Promise<unknown> {
  const { rows } = await rawQuery(connection, "select current_setting($1, true)", [name]);
  return rows[0]?.[0];
}

describe("transactions", () => {
  test("commit what the callback did when it resolves, and resolve with its value", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      const value = await db.transaction(async (tx) => {
        await note(tx, "kept");
        return "done";
      });
      expect(value).toBe("done");
      await expect(bodies(db)).resolves.toStrictEqual(["kept"]);
    }
  });

  test("roll back everything the callback did when it rejects, with its error", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      const failure = new Error("changed my mind");
      const rejected = db.transaction(async (tx) => {
        await note(tx, "first");
        await note(tx, "second");
        throw failure;
      });
      await expect(rejected).rejects.toBe(failure);
      await expect(bodies(db)).resolves.toStrictEqual([]);
    }
  });

  test("undo only a savepoint's work when its callback rejects", async ({ drivers }) => {
    for (const db of drivers) {
      await notes(db);
      await db.transaction(async (tx) => {
        await note(tx, "order");
        const points = tx.savepoint(async (sp) => {
          await note(sp, "points");
          throw new Error("no points today");
        });
        await expect(points).rejects.toThrow("no points today");
        await tx.savepoint(async (sp) => note(sp, "receipt"));
      });
      await expect(bodies(db)).resolves.toStrictEqual(["order", "receipt"]);
    }
  });

  test("run at the isolation level and access mode they ask for", async ({ drivers }) => {
    for (const db of drivers) {
      await notes(db);
      const isolation = await db.transaction(async (tx) => setting(tx, "transaction_isolation"), {
        isolation: "serializable",
      });
      expect(isolation).toBe("serializable");
      const write = db.transaction(async (tx) => note(tx, "nope"), { readOnly: true });
      await expect(write).rejects.toMatchObject({ code: "25006" });
    }
  });

  test("apply settings for the transaction only", async ({ drivers }) => {
    for (const db of drivers) {
      const inside = await db.transaction(async (tx) => setting(tx, "app.user_id"), {
        settings: { "app.user_id": "42" },
      });
      expect(inside).toBe("42");
      const after = await db.transaction(async (tx) => setting(tx, "app.user_id"));
      expect([null, ""]).toContain(after);
    }
  });

  test("refuse queries on a transaction that has ended", async ({ drivers }) => {
    for (const db of drivers) {
      await notes(db);
      const escaped = await db.transaction(async (tx) => {
        await note(tx, "inside");
        return tx;
      });
      await expect(note(escaped, "late")).rejects.toThrow("transaction has ended");
    }
  });
});

const conflict = "do $$ begin raise exception 'conflict' using errcode = '40001'; end $$";
const CONFLICTS = 2;

/** What run number `run` (from 1) executes: a serialization failure for the first few runs. */
function conflictingAt(run: number): string {
  return run <= CONFLICTS ? conflict : "select 1";
}

describe("retrying transactions", () => {
  test("run the callback again after a serialization failure, up to the attempts given", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      let attempts = 0;
      const value = await db.transaction(
        async (tx) => {
          attempts += 1;
          await rawQuery(tx, conflictingAt(attempts), []);
          return attempts;
        },
        { retry: { attempts: CONFLICTS + 1 } },
      );
      expect(value).toBe(CONFLICTS + 1);
    }
  });

  test("give up with the last error once the attempts are used", async ({ drivers }) => {
    for (const db of drivers) {
      let attempts = 0;
      const rejected = db.transaction(
        async (tx) => {
          attempts += 1;
          await rawQuery(tx, conflict, []);
        },
        { retry: { attempts: 2 } },
      );
      await expect(rejected).rejects.toBeInstanceOf(QueryError);
      expect(attempts).toBe(2);
    }
  });

  test("never run the callback again unless asked, or for other errors", async ({ drivers }) => {
    for (const db of drivers) {
      await notes(db);
      let attempts = 0;
      const unasked = db.transaction(async (tx) => {
        attempts += 1;
        await rawQuery(tx, conflict, []);
      });
      await expect(unasked).rejects.toMatchObject({ code: "40001" });
      const other = db.transaction(
        async (tx) => {
          attempts += 1;
          await note(tx, "same");
          await note(tx, "same");
        },
        { retry: { attempts: 5 } },
      );
      await expect(other).rejects.toMatchObject({ code: "23505" });
      expect(attempts).toBe(2);
    }
  });
});
