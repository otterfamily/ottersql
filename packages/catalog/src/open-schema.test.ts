import { describe, expect, test } from "vitest";

import { openSchema } from "./index.ts";

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
});
