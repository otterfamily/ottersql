create type post_status as enum ('draft', 'published', 'archived');

create table users (
  id int8 generated always as identity primary key,
  email text not null unique,
  name text not null
);

create table posts (
  id int8 generated always as identity primary key,
  author_id int8 not null references users,
  title text not null,
  body text,
  status post_status not null default 'draft'
);

create index posts_author_id on posts (author_id);
