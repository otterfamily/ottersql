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
  test("declares a typed function per query, with flat named types", async ({ session }) => {
    const rendered = await session.renderFile(
      "-- @name userName\nselect name from users where id = :id;\n\n-- @name everyone\nselect id from users",
    );
    expect(rendered.text).toBe(
      [
        'import type { Connection } from "@ottersql/sql";',
        "export interface UserNameParams { readonly id: string | null; }",
        "export interface UserNameRow { readonly name: string; }",
        "export declare function userName(connection: Connection, params: UserNameParams): Promise<UserNameRow[]>;",
        "export interface EveryoneRow { readonly id: string; }",
        "export declare function everyone(connection: Connection): Promise<EveryoneRow[]>;",
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
