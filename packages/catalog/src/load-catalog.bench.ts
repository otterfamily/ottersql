import { describe, test } from "vitest";

import { loadCatalog } from "./index.ts";

const TABLES = 50;
const SMALL = 5;

function repeat(count: number, sql: (index: number) => string): string[] {
  return Array.from({ length: count }, (_value, index) => sql(index));
}

function tableSql(index: number): string {
  const parent = index > 0 ? `, parent_id int8 references t${index - 1} (id)` : "";
  return `
    create table t${index} (
      id int8 generated always as identity primary key,
      code text not null unique,
      status text not null default 'new' check (status in ('new', 'active', 'closed')),
      mood mood0,
      score numeric(10, 2),
      tags text[] not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz,
      note varchar(200)${parent}
    );
    create index t${index}_created on t${index} (created_at desc);
    create index t${index}_open on t${index} (lower(code)) where status <> 'closed';
    comment on table t${index} is 'Table ${index}\n@history';
    comment on column t${index}.code is 'Code';
  `;
}

function routineSql(index: number): string {
  return `
    create function f${index}(a int, b int default 1) returns table (x int, y text)
      language sql stable as 'select a + b, ''y''';
  `;
}

const schemaSql = [
  ...repeat(SMALL, (index) => `create type mood${index} as enum ('a', 'b', 'c');`),
  ...repeat(
    SMALL,
    (index) => `create domain level${index} as text check (value in ('low', 'high'));`,
  ),
  ...repeat(TABLES, tableSql),
  ...repeat(SMALL, (index) => `create view v${index} as select id, code from t${index};`),
  ...repeat(SMALL, routineSql),
].join("\n");

describe("loadCatalog", () => {
  test("cost by schema size", async ({ bench }) => {
    await bench.compare(
      bench("an empty schema", async () => {
        await loadCatalog("");
      }),
      bench(`${TABLES} tables with keys, checks, indexes and comments`, async () => {
        await loadCatalog(schemaSql);
      }),
      { iterations: 20, time: 0 },
    );
  });
});
