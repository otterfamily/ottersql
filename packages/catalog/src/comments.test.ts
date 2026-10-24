import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";
import { table } from "./test-helpers.ts";

describe("comments", () => {
  test("reads comments on tables, columns, enums and domains", async () => {
    const catalog = await loadCatalog(`
      create table t (a int);
      create type mood as enum ('ok');
      create domain positive as int check (value > 0);
      comment on table t is 'Things';
      comment on column t.a is 'An a';
      comment on type mood is 'How it feels';
      comment on domain positive is 'Above zero';
    `);
    expect([
      table(catalog, "t").comment?.text,
      table(catalog, "t").columns[0]?.comment?.text,
      catalog.enums[0]?.comment?.text,
      catalog.domains[0]?.comment?.text,
    ]).toStrictEqual(["Things", "An a", "How it feels", "Above zero"]);
  });

  test("has no comment where none was written", async () => {
    const catalog = await loadCatalog(`create table t (a int);`);
    expect([table(catalog, "t").comment, table(catalog, "t").columns[0]?.comment]).toStrictEqual([
      null,
      null,
    ]);
  });

  test.each([
    { comment: "Plain text", annotations: [] },
    { comment: "@history", annotations: [{ name: "history", argument: null }] },
    {
      comment: "Orders.\n@history\n  @retain-for 90 days  \nnot @an annotation",
      annotations: [
        { name: "history", argument: null },
        { name: "retain-for", argument: "90 days" },
      ],
    },
    { comment: "@ alone\n@Upper\n@1st", annotations: [] },
  ])("reads $annotations from $comment", async ({ comment, annotations }) => {
    const literal = comment.replaceAll("'", "''");
    const catalog = await loadCatalog(
      `create table t (a int); comment on table t is '${literal}';`,
    );
    expect(table(catalog, "t").comment).toStrictEqual({ text: comment, annotations });
  });
});
