import { describe, expect, test } from "vitest";

import { migrate } from "./test-migrate.ts";

describe("planMigration orders steps by what they depend on", () => {
  test.for([
    {
      change: "a new table's foreign key to a unique key added to an existing table",
      from: "create table a (id int8 primary key, code text not null)",
      to: "create table a (id int8 primary key, code text not null unique); create table b (id int8 primary key, code text references a (code))",
    },
    {
      change: "a new table's foreign key to a primary key added to an existing table",
      from: "create table a (id int8 not null)",
      to: "create table a (id int8 primary key); create table b (a int8 references a)",
    },
    {
      change: "dropping a table and the one that references it, the referenced one first by name",
      from: "create table a (id int8 primary key); create table b (id int8 primary key, a int8 references a)",
      to: "",
    },
    {
      change: "dropping two tables that reference each other",
      from: `create table a (id int8 primary key, b int8); create table b (id int8 primary key, a int8 references a);
        alter table a add foreign key (b) references b`,
      to: "",
    },
    {
      change: "dropping a unique key and the foreign key that references it, the key first by name",
      from: "create table a (id int8 primary key, code text unique); create table z (id int8 primary key, code text references a (code))",
      to: "create table a (id int8 primary key, code text); create table z (id int8 primary key, code text)",
    },
    {
      change:
        "dropping a primary key and the foreign key that references it, the key first by name",
      from: "create table a (id int8 primary key); create table z (a int8 references a)",
      to: "create table a (id int8); create table z (a int8)",
    },
  ])("plans $change so that it runs", async ({ from, to }) => {
    const { after, target } = await migrate(from, to);
    expect(after).toStrictEqual(target);
  });
});
