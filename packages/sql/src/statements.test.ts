import { describe, expect, test } from "vitest";

import { splitStatements } from "./index.ts";

describe("splitStatements", () => {
  test("splits at semicolons outside strings, quoted names, dollar quotes and comments", () => {
    const sql = [
      "create table \"a;b\" (c text default 'x;y'); -- a comment;",
      "create function f() returns text language sql as $body$ select ';' $body$;",
      "/* block; */ select 1",
    ].join("\n");
    expect(splitStatements(sql)).toStrictEqual([
      "create table \"a;b\" (c text default 'x;y')",
      "create function f() returns text language sql as $body$ select ';' $body$",
      "select 1",
    ]);
  });

  test("finds no statements in comments and blank lines", () => {
    expect(splitStatements("-- nothing\n\n/* here */ ;\n")).toStrictEqual([]);
  });
});
