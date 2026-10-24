import type { PGlite } from "@electric-sql/pglite";
import { protocol } from "@electric-sql/pglite";

import { field, isNode, list, readNodeTree } from "./node-tree.ts";
import type { NodeObject } from "./node-tree.ts";

export interface StatementDescription {
  readonly kind: "described";
  readonly parameterTypes: readonly number[];
  readonly fields: readonly {
    readonly name: string;
    readonly tableID: number;
    readonly columnID: number;
    readonly dataTypeID: number;
  }[];
  /** The analyzed Query, when the session sends it back (ADR 0009). */
  readonly tree: NodeObject | null;
}

export interface PostgresError {
  readonly kind: "error";
  readonly message: string;
  /** 1-based, in characters of the SQL sent. */
  readonly position: number | null;
}

const { messages: backend, serialize } = protocol;

/** Parses and describes `sql` without running it, through one Parse, Describe and Sync. */
export async function describeStatement(
  db: PGlite,
  sql: string,
): Promise<StatementDescription | PostgresError> {
  const replies = [];
  for (const message of [
    serialize.parse({ text: sql, types: [] }),
    serialize.describe({ type: "S" }),
    serialize.sync(),
  ]) {
    const reply = await db.execProtocol(message, { throwOnError: false });
    replies.push(...reply.messages);
  }
  const error = replies.find((message) => message instanceof backend.DatabaseError);
  if (error !== undefined) {
    const position = error.position === undefined ? null : Number(error.position);
    return { kind: "error", message: error.message, position };
  }
  return {
    kind: "described",
    parameterTypes:
      replies.find((message) => message instanceof backend.ParameterDescriptionMessage)
        ?.dataTypeIDs ?? [],
    fields:
      replies.find((message) => message instanceof backend.RowDescriptionMessage)?.fields ?? [],
    tree: analyzedQuery(
      replies
        .filter((message) => message instanceof backend.NoticeMessage)
        .find((notice) => notice.message === "rewritten parse tree:")?.detail,
    ),
  };
}

/**
 * The statement's own Query node in a rewritten parse tree, which is a list of Query nodes. A tree
 * that cannot be read gives `null`, which leaves every column nullable rather than failing the file.
 */
function analyzedQuery(detail: string | undefined): NodeObject | null {
  const tree = readable(detail);
  const query = list(tree).find(
    (node) => isNode(node, "QUERY") && field(node, "canSetTag") === "true",
  );
  return isNode(query, "QUERY") ? query : null;
}

function readable(detail: string | undefined): ReturnType<typeof readNodeTree> | undefined {
  if (detail === undefined) {
    return undefined;
  }
  try {
    return readNodeTree(detail);
  } catch {
    return undefined;
  }
}
