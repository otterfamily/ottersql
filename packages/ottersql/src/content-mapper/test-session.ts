import { openQuerySession } from "./index.ts";
import type { DescribedQuery, QuerySession } from "./index.ts";

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
  create table legacy (
    id int8 primary key,
    code text check (code is not null),
    pair text,
    other text,
    check (pair is not null and other <> '')
  );
  alter table legacy add column note text, add constraint note_present check (note is not null) not valid;
  create table spans (id int8 primary key, r int4range not null, a int[] not null);
  create table parent (
    id int8 primary key,
    own text not null no inherit,
    shared text not null,
    checked text,
    check (checked is not null) no inherit
  );
  create table child () inherits (parent);
  create function fill_slug() returns trigger language plpgsql as $$
    begin new.slug := coalesce(new.slug, 'slug-' || new.id); return new; end $$;
  create table stamped (id int8 primary key, slug text not null);
  create trigger fills_slug before insert on stamped for each row execute function fill_slug();
  create function maybe(i int) returns text language sql as 'select null';
  create type wrapped as (v text);
  create function wrap(i int) returns wrapped language sql as 'select null::wrapped';
  create cast (int as wrapped) with function wrap(int);
  create view author_posts as
    select u.name, p.title from users u left join posts p on p.author_id = u.id;
`;

/** A Vitest fixture: a query session over a schema of users, posts and edge cases. */
export async function openSession(
  {}: object,
  use: (session: QuerySession) => Promise<void>,
): Promise<void> {
  const session = await openQuerySession(schemaSql);
  await use(session);
  await session.close();
}

/** The one query `sql` describes, named `q`. */
export async function onlyQuery(session: QuerySession, sql: string): Promise<DescribedQuery> {
  const file = await session.describeFile(`-- @name q\n${sql}`);
  const [query] = file.queries;
  if (query === undefined || file.problems.length > 0) {
    throw new Error(`expected one described query, got ${JSON.stringify(file.problems)}`);
  }
  return query;
}

/** Whether each result column of `sql` may be null, by name. */
export async function nullability(
  session: QuerySession,
  sql: string,
): Promise<Record<string, boolean>> {
  const query = await onlyQuery(session, sql);
  return Object.fromEntries(query.columns.map(({ name, nullable }) => [name, nullable]));
}
