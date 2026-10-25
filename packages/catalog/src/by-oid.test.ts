import { pgliteConnection } from "@ottersql/sql/pglite";
import { describe, expect, test } from "vitest";

import { openSchema, readRelations, readTypeRefs } from "./index.ts";
import type { OpenSchema } from "./index.ts";

async function oidsOf(
  schema: OpenSchema,
): Promise<{ readonly table: number; readonly int8: number; readonly moods: number }> {
  const { rows } = await schema.database.query<{ table: number; int8: number; moods: number }>(
    `select 't'::regclass::oid::int as "table", 'int8'::regtype::oid::int as int8,
       'mood[]'::regtype::oid::int as moods`,
  );
  const [oids] = rows;
  if (oids === undefined) {
    throw new Error("no oids");
  }
  return oids;
}

describe("lookups by oid", () => {
  test("reads type references and relations for the oids Postgres reports", async () => {
    const schema = await openSchema(`
      create type mood as enum ('ok');
      create table t (a int8, dropped int, b mood);
      alter table t drop column dropped;
    `);
    try {
      const oids = await oidsOf(schema);
      const connection = pgliteConnection(schema.database);
      const types = await readTypeRefs(connection, [oids.int8, oids.moods]);
      const relations = await readRelations(connection, [oids.table]);
      expect({
        types: [types.get(oids.int8), types.get(oids.moods)],
        relation: relations.get(oids.table),
      }).toStrictEqual({
        types: [
          { kind: "base", schema: "pg_catalog", name: "int8" },
          { kind: "array", element: { kind: "enum", schema: "public", name: "mood" } },
        ],
        relation: {
          schema: "public",
          name: "t",
          columns: new Map([
            [1, "a"],
            [3, "b"],
          ]),
        },
      });
    } finally {
      await schema.close();
    }
  });
});
