import { describe, expect, test as base } from "vitest";

import type { QuerySession } from "./index.ts";
import { onlyQuery, openSession } from "./test-session.ts";

const test = base.extend<{ session: QuerySession }>({
  session: [openSession, { scope: "file" }],
});

describe("parameter nullability", () => {
  test.for([
    {
      sql: "insert into users (id, name, bio, mood) values (:id, :name, :bio, 'ok')",
      expected: { id: false, name: false, bio: true },
    },
    {
      sql: "insert into users (id, name, mood) values (:a, :b, 'ok'), (:c, :d, 'bad')",
      expected: { a: false, b: false, c: false, d: false },
    },
    {
      sql: "update users set name = :name, bio = :bio where id = :id",
      expected: { name: false, bio: true, id: true },
    },
    {
      sql: "insert into users (id, name, mood) values (:id, :name, 'ok') on conflict (id) do update set name = :rename",
      expected: { id: false, name: false, rename: true },
    },
    {
      sql: "insert into users (id, name, mood) values (:id::int4, :name::varchar, 'ok')",
      expected: { id: false, name: false },
    },
    {
      sql: "insert into users (id, name, mood) values (coalesce(:id, 1), :name, 'ok')",
      expected: { id: true, name: false },
    },
    {
      sql: "insert into users (id, name, mood) select :id, :name, 'ok'",
      expected: { id: false, name: false },
    },
    {
      sql: "insert into users (id, name, mood) select :id, :name, mood from users where false",
      expected: { id: false, name: false },
    },
    {
      sql: "insert into stamped (id, slug) values (:id, :slug)",
      expected: { id: true, slug: true },
    },
    {
      sql: "update stamped set slug = :slug where id = :id",
      expected: { slug: false, id: true },
    },
    {
      sql: "update parent set own = :own, shared = :shared",
      expected: { own: true, shared: false },
    },
    {
      sql: "update only parent set own = :own",
      expected: { own: false },
    },
    {
      sql: "select id from users where name = :name",
      expected: { name: true },
    },
  ])(
    "takes no null only where Postgres rejects it: $sql",
    async ({ sql, expected }, { session }) => {
      const query = await onlyQuery(session, sql);
      expect(
        Object.fromEntries(query.parameters.map(({ name, nullable }) => [name, nullable])),
      ).toStrictEqual(expected);
    },
  );
});
