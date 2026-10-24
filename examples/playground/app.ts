// Hover over the names below to see the types ottersql derives from schema.sql and queries.sql.
import type { Connection } from "@ottersql/sql";

import {
  createUser,
  postCountsByStatus,
  postsWithAuthors,
  publishedTitles,
  searchPosts,
  userById,
} from "./queries.sql";

declare const connection: Connection;

const [user] = await userById(connection, { id: "1" });
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
const [created] = await createUser(connection, { email: "otter@example.com", name: "Otter" });

export { author, bio, body, created, plan, status, titles, total };
