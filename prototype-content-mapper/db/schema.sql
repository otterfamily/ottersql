create table users (
  id    int primary key generated always as identity,
  name  text not null,
  bio   text
);

create table posts (
  id         int primary key generated always as identity,
  author_id  int not null references users (id),
  title      text not null,
  status     text not null check (status in ('draft', 'published')),
  created_at timestamptz not null default now()
);
