create type post_status as enum ('draft', 'published', 'archived');

create domain email as text check (value ~ '^[^@]+@[^@]+$');

create table users (
  id int8 generated always as identity primary key,
  email email not null unique,
  name text not null,
  bio text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

create table posts (
  id int8 generated always as identity primary key,
  author_id int8 not null references users (id) on delete cascade,
  title text not null,
  body text,
  status post_status not null default 'draft',
  published_on date,
  tags text[] not null default '{}'
);

create view published_posts as
  select p.id, p.title, u.name as author
  from posts p join users u on u.id = p.author_id
  where p.status = 'published';

comment on table posts is 'Posts written by users
@history';
