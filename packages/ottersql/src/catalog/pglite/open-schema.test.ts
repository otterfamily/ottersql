import { describe, expect, test } from "vitest";

import { openSchema } from "../index.ts";

describe("openSchema", () => {
  test("keeps the database open with the schema applied, next to its catalog", async () => {
    const schema = await openSchema(`create table t (a int not null); insert into t values (1);`);
    try {
      const { rows } = await schema.database.query<{ a: number }>("select a from t");
      expect({ rows, tables: schema.catalog.tables.map((table) => table.name) }).toStrictEqual({
        rows: [{ a: 1 }],
        tables: ["t"],
      });
    } finally {
      await schema.close();
    }
  });

  test("with cache, restores the database an unchanged schema left instead of running it again", async () => {
    // A random value differs between runs of the schema, so an equal one shows it was restored.
    const sql = `create table cached (x float8 default random()); insert into cached default values;`;
    const valueOf = async (options: { readonly cache: boolean }): Promise<unknown> => {
      const schema = await openSchema(sql, options);
      try {
        const { rows } = await schema.database.query<{ x: number }>("select x from cached");
        return rows[0]?.x;
      } finally {
        await schema.close();
      }
    };
    const first = await valueOf({ cache: true });
    expect({
      restored: await valueOf({ cache: true }),
      rerun: (await valueOf({ cache: false })) === first,
    }).toStrictEqual({ restored: first, rerun: false });
  });
});
