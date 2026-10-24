import { describe, expect, test as base } from "vitest";

import { openQuerySession } from "./index.ts";
import type { QuerySession } from "./index.ts";

const schemaSql = `
  create type mood as enum ('ok', 'it''s bad');
  create domain level as text check (value in ('low', 'high'));
  create table users (
    id int8 primary key,
    name text not null,
    status text not null check (status in ('draft', 'published')),
    mood mood,
    level level not null,
    tags text[] not null,
    score numeric(10, 2),
    born date,
    seen timestamptz not null,
    local_seen timestamp,
    wake time,
    nap interval,
    data jsonb,
    avatar bytea,
    stay daterange,
    small int2, medium int4, real float8, flag bool, uid uuid
  );
`;

const test = base.extend<{ session: QuerySession }>({
  session: [
    async ({}, use) => {
      const session = await openQuerySession(schemaSql);
      await use(session);
      await session.close();
    },
    { scope: "file" },
  ],
});

/** The `readonly name: type;` members of an interface in the rendered module. */
function members(text: string, interfaceName: string): Record<string, string> {
  const body = new RegExp(
    String.raw`export interface ${interfaceName} \{(?<body>[^\}]*)\}`,
    "v",
  ).exec(text)?.groups?.["body"];
  return Object.fromEntries(
    [...(body ?? "").matchAll(/readonly (?<name>"[^"]*"|\S+): (?<type>[^;]+);/gv)].map((match) => [
      match.groups?.["name"] ?? "",
      match.groups?.["type"] ?? "",
    ]),
  );
}

describe("rendered module", () => {
  test("declares a typed query per query, with flat named types", async ({ session }) => {
    const rendered = await session.renderFile(
      "-- @name userName\nselect name from users where id = :id;\n\n-- @name everyone\nselect id from users",
    );
    expect(rendered.text).toBe(
      [
        'import type { TypedQuery } from "@ottersql/sql";',
        "export interface UserNameParams { readonly id: string | number | bigint | null; }",
        "export interface UserNameRow { readonly name: string; }",
        "export declare const userName: TypedQuery<UserNameParams, UserNameRow>;",
        "export interface EveryoneRow { readonly id: string; }",
        "export declare const everyone: TypedQuery<undefined, EveryoneRow>;",
        "",
      ].join("\n"),
    );
  });

  test("types columns by ADR 0008's codecs and the values the database allows", async ({
    session,
  }) => {
    const rendered = await session.renderFile("-- @name all\nselect * from users");
    expect(members(rendered.text, "AllRow")).toStrictEqual({
      id: "string",
      name: "string",
      status: '"draft" | "published"',
      mood: '"ok" | "it\'s bad" | null',
      level: '"low" | "high"',
      tags: "(string | null)[]",
      score: "string | null",
      born: "Temporal.PlainDate | null",
      seen: "Temporal.Instant",
      local_seen: "Temporal.PlainDateTime | null",
      wake: "Temporal.PlainTime | null",
      nap: "Interval | null",
      data: "unknown",
      avatar: "Uint8Array | null",
      stay: "Range<Temporal.PlainDate> | null",
      small: "number | null",
      medium: "number | null",
      real: "number | null",
      flag: "boolean | null",
      uid: "string | null",
    });
  });

  test("accepts numbers and bigints for int8 parameters, while int8 results stay exact strings", async ({
    session,
  }) => {
    const rendered = await session.renderFile(
      "-- @name page\nselect id from users where id = any(:ids) limit :limit",
    );
    expect({
      params: members(rendered.text, "PageParams"),
      row: members(rendered.text, "PageRow"),
    }).toStrictEqual({
      params: {
        ids: "(string | number | bigint | null)[] | null",
        limit: "string | number | bigint | null",
      },
      row: { id: "string" },
    });
  });

  test("takes JSON parameters wrapped with json(...), while JSON results are plain values", async ({
    session,
  }) => {
    const rendered = await session.renderFile(
      "-- @name setData\nupdate users set data = :data where id = 1 returning data",
    );
    expect({
      params: members(rendered.text, "SetDataParams"),
      row: members(rendered.text, "SetDataRow"),
    }).toStrictEqual({ params: { data: "Json | null" }, row: { data: "unknown" } });
  });

  test("quotes a column name that is not an identifier", async ({ session }) => {
    const rendered = await session.renderFile(
      '-- @name odd\nselect name as "full name" from users',
    );
    expect(members(rendered.text, "OddRow")).toStrictEqual({ '"full name"': "string" });
  });
});

describe("diagnostics", () => {
  test.for([
    {
      content: "-- @name broken\nselect missing from users",
      diagnostic: { messageText: 'column "missing" does not exist', at: "missing from users" },
    },
    {
      content: "-- @name twice\nselect id, id from users",
      diagnostic: {
        messageText: 'Column "id" appears more than once; give each column its own name with AS',
        at: "twice\nselect id, id from users",
      },
    },
    {
      content: "-- @name TypedQuery\nselect id from users",
      diagnostic: {
        messageText: 'Query "TypedQuery" would clash with the TypedQuery type the module imports',
        at: "TypedQuery\nselect id from users",
      },
    },
    {
      content: "-- @name user\nselect id from users\n-- @name User\nselect name from users",
      diagnostic: {
        messageText:
          'Query "User" would declare the same UserParams and UserRow types as query "user"',
        at: "User\nselect name from users",
      },
    },
  ])("reports $diagnostic.messageText", async ({ content, diagnostic }, { session }) => {
    const rendered = await session.renderFile(content);
    expect(
      rendered.diagnostics.map(({ messageText, start }) => ({
        messageText,
        at: content.slice(start),
      })),
    ).toStrictEqual([diagnostic]);
  });
});
