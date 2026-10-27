import { PGlite } from "@electric-sql/pglite";
import { postgresDatabase } from "@ottersql/testing";
import { Pool } from "pg";
import { describe, expect, onTestFinished, test as base } from "vitest";

import { builtInOids } from "./built-in-types.ts";
import { driverConnection, rawQuery, sqlTransaction } from "./connection.ts";
import type { Connection, DriverQuery } from "./connection.ts";
import { pgConnection } from "./pg.ts";
import { pgliteConnection } from "./pglite.ts";
import { openDrivers } from "./test-drivers.ts";
import { typeInfos } from "./type-info.ts";
import type { TypeInfo } from "./type-info.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

function expectedTypeInfo([typtype, name, element, subtype]: readonly (
  | string
  | null
  | undefined
)[]): TypeInfo {
  if (element !== null && element !== undefined) {
    return { kind: "array", element: { kind: "base", name: element }, delimiter: "," };
  }
  if (typtype === "r" || typtype === "m") {
    const kind = typtype === "r" ? "range" : "multirange";
    return { kind, subtype: { kind: "base", name: subtype ?? "" } };
  }
  return { kind: "base", name: name ?? "" };
}

describe("built-in types", () => {
  test("match what pg_type says about their oids", async ({ drivers }) => {
    for (const connection of drivers) {
      const { rows } = await rawQuery(
        connection,
        `select t.oid, t.typtype, t.typname, element.typname, subtype.typname
         from pg_type t
         left join pg_type element on element.oid = t.typelem and t.typinput = 'array_in'::regproc
         left join pg_range r on t.oid in (r.rngtypid, r.rngmultitypid)
         left join pg_type subtype on subtype.oid = r.rngsubtype
         where t.oid = any($1::oid[])`,
        [`{${builtInOids.join(",")}}`],
      );
      const expected = new Map(rows.map(([oid, ...type]) => [Number(oid), expectedTypeInfo(type)]));
      await expect(typeInfos(connection, builtInOids)).resolves.toStrictEqual(expected);
    }
  });

  test("look a type up once for the queries that need it at the same time", async () => {
    const db = await PGlite.create();
    onTestFinished(async () => db.close());
    await db.exec("create type mood as enum ('ok', 'bad')");
    const direct = pgliteConnection(db);
    const { rows } = await rawQuery(direct, "select 'mood[]'::regtype::oid", []);
    const moods = Number(rows[0]?.[0]);
    let lookups = 0;
    const query: DriverQuery = async (sql, parameters) => {
      lookups += Number(sql.includes("from pg_type t"));
      return rawQuery(direct, sql, parameters);
    };
    const counted = driverConnection({
      query,
      transaction: async (run) => run(sqlTransaction(query)),
    });
    await Promise.all(Array.from({ length: 5 }, async () => typeInfos(counted, [moods])));
    // One for the array type, then one for its element.
    expect(lookups).toBe(2);
  });

  test("look a type up again when the lookup another transaction started fails there", async () => {
    const pool = new Pool({ connectionString: await postgresDatabase() });
    onTestFinished(async () => pool.end());
    const db = pgConnection(pool);
    await rawQuery(db, "create type mood as enum ('ok', 'bad')", []);
    const { rows } = await rawQuery(db, "select 'mood[]'::regtype::oid", []);
    const moods = Number(rows[0]?.[0]);
    let lookups: readonly PromiseSettledResult<unknown>[] = [];
    await db
      .transaction(async (tx) => {
        await rawQuery(tx, "select 1/0", []).catch(() => null);
        // The first lookup runs in a transaction that can no longer run statements.
        lookups = await Promise.allSettled([typeInfos(tx, [moods]), typeInfos(db, [moods])]);
      })
      .catch(() => null);
    expect(lookups.map((lookup) => lookup.status)).toStrictEqual(["rejected", "fulfilled"]);
  });
});
