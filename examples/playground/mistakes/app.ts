// Each line below misuses a typed query on purpose; VS Code underlines it.
import type { Connection } from "@ottersql/sql";

import { postsWithAuthors, userById } from "../queries.sql";

declare const connection: Connection;

// The id parameter is a string (int8 stays exact), not a number.
await userById(connection, { id: 1 });

// The parameters object is required.
await userById(connection);

// A parameter the query does not have.
await userById(connection, { id: "1", extra: true });

const [user] = await userById(connection, { id: "1" });
// bio can be null, so calling a string method on it is an error.
user?.bio.toUpperCase();
// The query does not select this column.
user?.nickname;

const posts = await postsWithAuthors(connection, { limit: "10" });
// author comes from the nullable side of a LEFT JOIN.
const author: string | undefined = posts[0]?.author;
// status is an enum; other strings are rejected.
const status: "draft" | "deleted" | undefined = posts[0]?.status;

export { author, status };
