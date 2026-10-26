// Each line below misuses a typed query on purpose; VS Code underlines it.
import type { Connection } from "ottersql";

import { postsWithAuthors, userById } from "../queries.sql";

declare const connection: Connection;

// The id parameter is an int8: a string, number or bigint, not a boolean.
await userById(connection, { id: true });

// The parameters object is required.
await userById(connection);

// A parameter the query does not have.
await userById(connection, { id: "1", extra: true });

const user = await userById.maybeOne(connection, { id: "1" });
// bio can be null, so calling a string method on it is an error.
user?.bio.toUpperCase();
// The query does not select this column.
user?.nickname;

const posts = await postsWithAuthors(connection, { limit: 10 });
// author comes from the nullable side of a LEFT JOIN.
const author: string | undefined = posts[0]?.author;
// status is an enum; other strings are rejected.
const status: "draft" | "deleted" | undefined = posts[0]?.status;

export { author, status };
