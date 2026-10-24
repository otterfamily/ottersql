import { describe, expect, test as base } from "vitest";

import { openQuerySession } from "./index.ts";
import type { DescribedFile, DescribedQuery, Problem, QuerySession } from "./index.ts";

const schemaSql = `
  create type mood as enum ('ok', 'bad');
  create table users (id int8 primary key, name text not null, bio text, mood mood not null);
  create table posts (
    id int8 primary key,
    author_id int8 not null references users (id),
    title text not null,
    status text not null check (status in ('draft', 'published'))
  );
  create view post_titles as select id, title from posts;
  create view author_posts as
    select u.name, p.title from users u left join posts p on p.author_id = u.id;
`;

const test = base.extend<{ session: QuerySession }>({
  session: [
    async ({}, use) => {
      const session = await openQuerySession(schemaSql);
      await use(session);
      await session.close();
    },
    { scope: "file" },
  ],
});

async function onlyQuery(session: QuerySession, sql: string): Promise<DescribedQuery> {
  const file = await session.describeFile(`-- @name q\n${sql}`);
  const [query] = file.queries;
  if (query === undefined || file.problems.length > 0) {
    throw new Error(`expected one described query, got ${JSON.stringify(file.problems)}`);
  }
  return query;
}

async function nullability(session: QuerySession, sql: string): Promise<Record<string, boolean>> {
  const query = await onlyQuery(session, sql);
  return Object.fromEntries(query.columns.map(({ name, nullable }) => [name, nullable]));
}

function problemsAt(content: string, file: DescribedFile): { message: string; at: string }[] {
  return file.problems.map((problem: Problem) => ({
    message: problem.message,
    at: content.slice(problem.span.start),
  }));
}

describe("parameters and columns", () => {
  test("reads the types Postgres infers for parameters and result columns", async ({ session }) => {
    const query = await onlyQuery(
      session,
      "select id, mood from users where id = :id and name = :name",
    );
    expect({
      parameters: query.parameters.map(({ name, type }) => ({ name, type })),
      columns: query.columns.map(({ name, type }) => ({ name, type })),
    }).toStrictEqual({
      parameters: [
        { name: "id", type: { kind: "base", schema: "pg_catalog", name: "int8" } },
        { name: "name", type: { kind: "base", schema: "pg_catalog", name: "text" } },
      ],
      columns: [
        { name: "id", type: { kind: "base", schema: "pg_catalog", name: "int8" } },
        { name: "mood", type: { kind: "enum", schema: "public", name: "mood" } },
      ],
    });
  });

  test("records the table column a result column comes from", async ({ session }) => {
    const query = await onlyQuery(session, "select status, upper(title) as shout from posts");
    expect(query.columns.map(({ origin }) => origin)).toStrictEqual([
      { schema: "public", table: "posts", column: "status" },
      null,
    ]);
  });
});

describe("nullability (ADR 0009)", () => {
  test.for([
    {
      sql: "select id, name, bio from users",
      expected: { id: false, name: false, bio: true },
    },
    {
      sql: "select u.name, p.title from users u left join posts p on p.author_id = u.id",
      expected: { name: false, title: true },
    },
    {
      sql: "select u.name, p.title from users u join posts p on p.author_id = u.id",
      expected: { name: false, title: false },
    },
    {
      sql: "select p.title, u.name from posts p right join users u on u.id = p.author_id",
      expected: { title: true, name: false },
    },
    {
      sql: "select count(*) as n, count(bio) as m, max(name) as top, 1 as one from users",
      expected: { n: false, m: false, top: true, one: false },
    },
    {
      sql: "select upper(name) as shout, :p::text as param, null::text as nothing from users",
      expected: { shout: false, param: true, nothing: true },
    },
    {
      sql: "insert into users (id, name, mood) values (:id, :name, 'ok') returning id, bio",
      expected: { id: false, bio: true },
    },
    {
      sql: "select coalesce(bio, 'none') as a, coalesce(bio, bio) as b from users",
      expected: { a: false, b: true },
    },
    {
      sql: "select case when bio is null then 'x' else name end as a, case when bio is null then 'x' end as b from users",
      expected: { a: false, b: true },
    },
    {
      sql: "select s.name, s.bio from (select name, bio from users) s",
      expected: { name: false, bio: true },
    },
    {
      sql: "with c as (select name, bio from users) select name, bio from c",
      expected: { name: false, bio: true },
    },
    {
      sql: "select name as v from users union all select title from posts union all select bio from users",
      expected: { v: true },
    },
    {
      sql: "select name as v from users union select title from posts",
      expected: { v: false },
    },
    {
      sql: "select id, title from post_titles",
      expected: { id: false, title: false },
    },
    {
      sql: "select name, title from author_posts",
      expected: { name: false, title: true },
    },
    {
      sql: "select id + 1 as a, name || '!' as b, name = 'x' as c, bio || '!' as d from users",
      expected: { a: false, b: false, c: false, d: true },
    },
    {
      sql: "select upper(name) as a, upper(bio) as b, concat(bio, 'x') as c, regexp_match(name, 'x') as d from users",
      expected: { a: false, b: true, c: false, d: true },
    },
    {
      sql: "select current_timestamp as a, row_number() over () as b, exists (select from posts) as c, bio is null as d, (select title from posts limit 1) as e from users",
      expected: { a: false, b: false, c: false, d: false, e: true },
    },
    {
      sql: "select id from users join posts using (id)",
      expected: { id: false },
    },
    {
      sql: "select id from users left join posts using (id)",
      expected: { id: false },
    },
    {
      sql: "select id from users full join posts using (id)",
      expected: { id: true },
    },
  ])("proves non-null only what it can in $sql", async ({ sql, expected }, { session }) => {
    await expect(nullability(session, sql)).resolves.toStrictEqual(expected);
  });
});

describe("problems", () => {
  test("reports a Postgres error at its place in the file", async ({ session }) => {
    const content = "-- @name q\nselect :id, missing from users";
    const file = await session.describeFile(content);
    expect({ problems: problemsAt(content, file), queries: file.queries.length }).toStrictEqual({
      problems: [{ message: 'column "missing" does not exist', at: "missing from users" }],
      queries: 0,
    });
  });

  test("reports the problems of the file itself", async ({ session }) => {
    const file = await session.describeFile("select 1");
    expect(file.problems.map(({ message }) => message)).toStrictEqual([
      "SQL must follow a -- @name line",
    ]);
  });
});
