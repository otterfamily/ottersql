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

/** Why a settled promise rejected, or `""` when it resolved. */
function reasonOf(result: Readonly<PromiseSettledResult<unknown>>): string {
  return result.status === "rejected" ? String(result.reason) : "";
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

  test("run at the isolation level, access mode and deferrability they ask for", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      const mode = await db.transaction(
        async (tx) =>
          Promise.all(
            ["transaction_isolation", "transaction_read_only", "transaction_deferrable"].map(
              async (name) => setting(tx, name),
            ),
          ),
        { isolation: "serializable", readOnly: true, deferrable: true },
      );
      expect(mode).toStrictEqual(["serializable", "on", "on"]);
      const defaults = await db.transaction(async (tx) => setting(tx, "transaction_isolation"));
      expect(defaults).toBe("read committed");
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

  test("reject with Postgres's error when a statement failed, even if the callback caught it", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      const swallowed = db.transaction(async (tx) => {
        await note(tx, "kept?");
        await note(tx, "kept?").catch(() => null);
        return "looks fine";
      });
      await expect(swallowed).rejects.toMatchObject({ code: "23505" });
      await expect(bodies(db)).resolves.toStrictEqual([]);
    }
  });

  test("undo a savepoint whose callback caught its statement's error, and go on", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      await db.transaction(async (tx) => {
        await note(tx, "order");
        const points = tx.savepoint(async (sp) => {
          await note(sp, "order").catch(() => null);
        });
        await expect(points).rejects.toMatchObject({ code: "23505" });
        await note(tx, "receipt");
      });
      await expect(bodies(db)).resolves.toStrictEqual(["order", "receipt"]);
    }
  });

  test("reject when a savepoint could not be rolled back to, even if the callback caught its error", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      const rejected = db.transaction(async (tx) => {
        await note(tx, "order");
        const points = tx.savepoint(async (sp) => {
          // Ends the transaction, so rolling back to the savepoint fails.
          await rawQuery(sp, "rollback", []);
          throw new Error("no points today");
        });
        await points.catch(() => null);
        return "done";
      });
      await expect(rejected).rejects.toBeInstanceOf(QueryError);
      await expect(bodies(db)).resolves.toStrictEqual([]);
    }
  });

  test("refuse queries on a transaction while one of its savepoints is open", async ({
    drivers,
  }) => {
    for (const db of drivers) {
      await notes(db);
      await db.transaction(async (tx) => {
        const outer = tx.savepoint(async () => note(tx, "outside the savepoint"));
        await expect(outer).rejects.toThrow("savepoint of this transaction is open");
        const [first, second] = await Promise.allSettled([
          tx.savepoint(async (sp) => note(sp, "first")),
          tx.savepoint(async (sp) => note(sp, "second")),
        ]);
        expect(first.status).toBe("fulfilled");
        expect(reasonOf(second)).toContain("savepoint of this transaction is open");
      });
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

  test("run the callback again after a serialization failure at commit", async ({ drivers }) => {
    for (const db of drivers) {
      // A deferred trigger fails at COMMIT while a sequence, which rollbacks leave alone, counts
      // fewer than CONFLICTS + 1 attempts.
      await rawQuery(db, "drop table if exists commits", []);
      await rawQuery(db, "drop sequence if exists commit_attempts", []);
      await rawQuery(db, "create sequence commit_attempts", []);
      await rawQuery(
        db,
        `create or replace function conflict_at_commit() returns trigger language plpgsql as $$
         begin
           if nextval('commit_attempts') <= ${String(CONFLICTS)} then
             raise exception 'conflict' using errcode = '40001';
           end if;
           return null;
         end $$`,
        [],
      );
      await rawQuery(db, "create table commits (n int4)", []);
      await rawQuery(
        db,
        `create constraint trigger conflicting after insert on commits deferrable initially deferred
         for each row execute function conflict_at_commit()`,
        [],
      );
      let attempts = 0;
      await db.transaction(
        async (tx) => {
          attempts += 1;
          await rawQuery(tx, "insert into commits values (1)", []);
        },
        { retry: { attempts: CONFLICTS + 1 } },
      );
      expect(attempts).toBe(CONFLICTS + 1);
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
