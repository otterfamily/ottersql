import { describe, expect, test } from "vitest";

import { lineComments, splitStatements } from "./tooling.ts";

describe("splitStatements", () => {
  test("splits at semicolons outside strings, quoted names, dollar quotes and comments, saying where each starts", () => {
    const sql = [
      "create table \"a;b\" (c text default 'x;y'); -- a comment;",
      "create function f() returns text language sql as $body$ select ';' $body$;",
      "/* block; */ select 1",
    ].join("\n");
    expect(splitStatements(sql)).toStrictEqual([
      { text: "create table \"a;b\" (c text default 'x;y')", start: 0 },
      {
        text: "create function f() returns text language sql as $body$ select ';' $body$",
        start: sql.indexOf("create function"),
      },
      { text: "select 1", start: sql.indexOf("select 1") },
    ]);
  });

  test("finds no statements in comments and blank lines", () => {
    expect(splitStatements("-- nothing\n\n/* here */ ;\n")).toStrictEqual([]);
  });
});

describe("lineComments", () => {
  test("finds -- comments outside strings, quoted names and dollar quotes, saying where each starts", () => {
    const sql = [
      "-- first",
      "select '-- not a comment', \"--\" from t; -- second",
      "select $$ -- nor this $$;",
    ].join("\n");
    expect(lineComments(sql)).toStrictEqual([
      { text: "-- first", start: 0 },
      { text: "-- second", start: sql.indexOf("-- second") },
    ]);
  });
});
