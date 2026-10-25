import { describe, expect, test } from "vitest";

import { fileOffset, readQueryFile } from "./tooling.ts";
import type { Query } from "./tooling.ts";

function onlyQuery(content: string): Query {
  const file = readQueryFile(content);
  expect(file.problems).toStrictEqual([]);
  const [query, ...others] = file.queries;
  if (query === undefined || others.length > 0) {
    throw new Error(`expected exactly one query, got ${String(file.queries.length)}`);
  }
  return query;
}

describe("named queries", () => {
  test("splits a file at each -- @name line", () => {
    const content = "-- @name first\nselect 1;\n\n-- @name second\nselect 2\n";
    const file = readQueryFile(content);
    expect(file.problems).toStrictEqual([]);
    expect(
      file.queries.map(({ name, nameSpan, sql }) => ({
        name,
        named: content.slice(nameSpan.start, nameSpan.start + nameSpan.length),
        sql,
      })),
    ).toStrictEqual([
      { name: "first", named: "first", sql: "select 1" },
      { name: "second", named: "second", sql: "select 2" },
    ]);
  });

  test("keeps a -- @name line inside a dollar-quoted body as SQL", () => {
    const query = onlyQuery("-- @name f\nselect $$\n-- @name not_a_query\n$$ as body");
    expect(query.sql).toBe("select $$\n-- @name not_a_query\n$$ as body");
  });

  test.each([
    { content: "select 1;\n-- @name a\nselect 2", message: "SQL must follow a -- @name line" },
    {
      content: "-- @name a\nselect 1;\n-- @name a\nselect 2",
      message: 'Query "a" is already defined',
    },
    { content: "-- @name 1st\nselect 1", message: '"1st" is not a valid query name' },
    { content: "-- @name a\n  -- nothing here\n", message: 'Query "a" has no SQL' },
    { content: "-- @name a\nselect 'open", message: "Unterminated quoted string" },
    { content: "-- @name a\nselect /* open", message: "Unterminated comment" },
    { content: '-- @name a\nselect "open', message: "Unterminated quoted identifier" },
    { content: "-- @name a\nselect $tag$ open", message: "Unterminated dollar-quoted string" },
    { content: "-- @name a\nselect $1", message: "Use :name parameters instead of $1" },
    { content: "-- @name delete\nselect 1", message: '"delete" is a reserved word in JavaScript' },
    {
      content: "-- @name eval\nselect 1",
      message: '"eval" cannot name a binding in strict mode JavaScript',
    },
    {
      content: "-- @name arguments\nselect 1",
      message: '"arguments" cannot name a binding in strict mode JavaScript',
    },
  ])("reports $message", ({ content, message }) => {
    expect(readQueryFile(content).problems.map((problem) => problem.message)).toStrictEqual([
      message,
    ]);
  });
});

describe("queries with problems", () => {
  test("leaves out a query whose SQL has a problem, rather than sending it to Postgres", () => {
    const file = readQueryFile("-- @name broken\nselect 'open\n");
    expect(file.queries).toStrictEqual([]);
  });
});

describe("parameters", () => {
  test("numbers :name parameters in order of first use and reuses the number for a repeat", () => {
    const content = "-- @name q\nselect * from t where a = :userId and b = :limit or c = :userId";
    const query = onlyQuery(content);
    expect(query.sql).toBe("select * from t where a = $1 and b = $2 or c = $1");
    expect(
      query.parameters.map(({ name, spans }) => ({
        name,
        written: spans.map(({ start, length }) => content.slice(start, start + length)),
      })),
    ).toStrictEqual([
      { name: "userId", written: [":userId", ":userId"] },
      { name: "limit", written: [":limit"] },
    ]);
  });

  test.each([
    ["a type cast", "select a::text from t"],
    ["a string", "select '12:30' from t"],
    ["a string with a doubled quote", "select 'it'':s :x' from t"],
    ["an escape string", String.raw`select E'it\':s :x' from t`],
    ["a Unicode escape string", String.raw`select U&'d\0061t:a' from t`],
    ["a bit string", "select B'1:0' from t"],
    ["a quoted identifier", 'select "a:b" from t'],
    ["a dollar-quoted string", "select $$ :x $$ from t"],
    ["a tagged dollar-quoted string", "select $fn$ :x $other$ :y $fn$ from t"],
    ["a line comment", "select 1 -- :x\nfrom t"],
    ["a nested block comment", "select 1 /* :x /* :y */ :z */ from t"],
    ["an array slice with numbers", "select a[1:2] from t"],
    ["an array slice with names", "select a[lo:hi] from t"],
    ["a named argument with :=", "select f(a := 1) from t"],
  ])("finds no parameter in %s", (_label, sql) => {
    const query = onlyQuery(`-- @name q\n${sql}`);
    expect({ sql: query.sql, parameters: query.parameters }).toStrictEqual({ sql, parameters: [] });
  });
});

describe("positions", () => {
  test("maps an offset in the SQL sent to Postgres back to the file", () => {
    const content = "-- @name q\nselect :longName, missing from t";
    const query = onlyQuery(content);
    const sqlOffset = query.sql.indexOf("missing");
    expect(content.slice(fileOffset(query, sqlOffset))).toBe("missing from t");
  });
});
