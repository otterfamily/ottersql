import { describe, expect, test as base } from "vitest";

import { openQuerySession } from "./index.ts";
import type { DescribedFile, Problem, QuerySession } from "./index.ts";
import { nullability, onlyQuery, openSession } from "./test-session.ts";

const test = base.extend<{ session: QuerySession }>({
  session: [openSession, { scope: "file" }],
});

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
      sql: "delete from users where id = 1 returning new.id as gone, old.id as was, id as kept",
      expected: { gone: true, was: false, kept: false },
    },
    {
      sql: "insert into users (id, name, mood) values (1, 'a', 'ok') returning old.name as was, new.name as now",
      expected: { was: true, now: false },
    },
    {
      sql: "select name, bio, count(*) as n from users group by name, bio",
      expected: { name: false, bio: true, n: false },
    },
    {
      sql: "select name, count(*) as n from users group by rollup (name)",
      expected: { name: true, n: false },
    },
    {
      sql: "select own, shared, checked from parent",
      expected: { own: true, shared: false, checked: true },
    },
    {
      sql: "select own, shared, checked from only parent",
      expected: { own: false, shared: false, checked: false },
    },
    {
      sql: "select code, pair, other, note from legacy",
      expected: { code: false, pair: false, other: true, note: true },
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
    {
      sql: "select lower(r) as lo, upper(r) as hi from spans",
      expected: { lo: true, hi: true },
    },
    {
      sql: "select to_char(now(), '') as a, concat(variadic null::text[]) as b, concat(variadic a::text[]) as c, concat('x', null) as d from spans",
      expected: { a: true, b: true, c: true, d: false },
    },
    {
      sql: "select (1::int)::wrapped as w from spans",
      expected: { w: true },
    },
    {
      sql: "select a + 1 as b from (select id as a from users) q",
      expected: { b: false },
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

describe("merge", () => {
  test("types every column RETURNING by MERGE as nullable, since its join is built after analysis", async ({
    session,
  }) => {
    await expect(
      nullability(
        session,
        "merge into users u using posts p on p.author_id = u.id when not matched by source then delete returning u.name, p.title",
      ),
    ).resolves.toStrictEqual({ name: true, title: true });
  });
});

describe("determinism", () => {
  test("proves the same columns whatever the session described before", async () => {
    const fresh = await openQuerySession("create table t (a int not null);");
    try {
      await expect(
        nullability(fresh, "select a + 1 as b from (select a from t) q"),
      ).resolves.toStrictEqual({
        b: false,
      });
    } finally {
      await fresh.close();
    }
  });
});
