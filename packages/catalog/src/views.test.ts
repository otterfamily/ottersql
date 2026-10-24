import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";

describe("views", () => {
  test("reads views and materialized views with their column names and types", async () => {
    const catalog = await loadCatalog(`
      create table users (id int8 primary key, name text not null);
      create view user_names as select id, upper(name) as name from users;
      create materialized view user_count as select count(*) as total from users;
      comment on view user_names is 'Shouting';
    `);
    expect(catalog.views).toStrictEqual([
      {
        schema: "public",
        name: "user_count",
        materialized: true,
        columns: [
          {
            name: "total",
            type: { kind: "base", schema: "pg_catalog", name: "int8" },
            typeSql: "bigint",
            comment: null,
          },
        ],
        comment: null,
      },
      {
        schema: "public",
        name: "user_names",
        materialized: false,
        columns: [
          {
            name: "id",
            type: { kind: "base", schema: "pg_catalog", name: "int8" },
            typeSql: "bigint",
            comment: null,
          },
          {
            name: "name",
            type: { kind: "base", schema: "pg_catalog", name: "text" },
            typeSql: "text",
            comment: null,
          },
        ],
        comment: { text: "Shouting", annotations: [] },
      },
    ]);
  });

  test("does not list views among tables", async () => {
    const catalog = await loadCatalog(`create view v as select 1 as one;`);
    expect(catalog.tables).toStrictEqual([]);
  });
});
