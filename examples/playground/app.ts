// Hover over the names below to see the types ottersql derives from schema.sql and queries.sql.
// Run it with `pnpm start`: the queries run on an in-process Postgres (PGlite).
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { pgliteConnection } from "ottersql/pglite";

import {
  createPost,
  createUser,
  postCountsByStatus,
  postsWithAuthors,
  publishedTitles,
  searchPosts,
  userById,
} from "./queries.sql";

const db = await PGlite.create();
await db.exec(await readFile(new URL("schema.sql", import.meta.url), "utf8"));
const connection = pgliteConnection(db);

const created = await createUser.one(connection, { email: "otter@example.com", name: "Otter" });
await createPost(connection, {
  authorId: created.id,
  title: "Swimming",
  status: "published",
  publishedOn: Temporal.PlainDate.from("2026-10-01"),
  tags: ["water"],
});
await createPost(connection, {
  authorId: created.id,
  title: "Otter notes",
  status: "draft",
  publishedOn: null,
  tags: [],
});

const user = await userById.maybeOne(connection, { id: created.id });
const plan: "free" | "pro" | undefined = user?.plan;
const bio: string | null | undefined = user?.bio;

const posts = await postsWithAuthors(connection, { limit: 20 });
const author: string | null | undefined = posts[0]?.author;
const status: "draft" | "published" | "archived" | undefined = posts[0]?.status;

const counts = await postCountsByStatus(connection);
const total: string | undefined = counts[0]?.total;

const found = await searchPosts(connection, { term: "otter" });
const body: string | undefined = found[0]?.body;

const titles = await publishedTitles(connection);

console.log({ created, plan, bio, author, status, total, body, counts, titles });
await db.close();
