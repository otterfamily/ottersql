import type { Comment, QualifiedName } from "../catalog/index.ts";
import type { Lock } from "./plan.ts";
import { identifier, literal, qualified } from "./sql-text.ts";
import { noChanges, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

type Commentable = "TABLE" | "COLUMN" | "CONSTRAINT" | "INDEX" | "TYPE" | "SCHEMA";

/**
 * `COMMENT ON` a table, column, constraint or index takes a SHARE UPDATE EXCLUSIVE lock, and on a
 * type or schema none that blocks reads or writes.
 */
const commentLocks: Readonly<Record<Commentable, Lock>> = {
  TABLE: "share update exclusive",
  COLUMN: "share update exclusive",
  CONSTRAINT: "share update exclusive",
  INDEX: "share update exclusive",
  TYPE: "none",
  SCHEMA: "none",
};

export function commentChange(target: {
  readonly on: Commentable;
  readonly object: string;
  /** The object as SQL names it. */
  readonly name: string;
  readonly before: Comment | null;
  readonly after: Comment | null;
}): Changes {
  const { on, object, name, before, after } = target;
  if (before?.text === after?.text) {
    return noChanges;
  }
  const text = after === null ? "NULL" : literal(after.text);
  return only(
    step({
      kind: "comment",
      object,
      statements: [`COMMENT ON ${on} ${name} IS ${text}`],
      phase: "expand",
      reversal: "reversible",
      lock: commentLocks[on],
    }),
  );
}

interface Commented {
  readonly name: string;
  readonly comment: Comment | null;
}

/** A changed comment of a constraint of `table` that is otherwise kept as it is. */
export function constraintCommentChange(
  table: QualifiedName,
  old: Commented,
  current: Commented,
): Changes {
  return commentChange({
    on: "CONSTRAINT",
    object: objectName(table, current.name),
    name: `${identifier(current.name)} ON ${qualified(table.schema, table.name)}`,
    before: old.comment,
    after: current.comment,
  });
}

/** A changed comment of an index of `table` that is otherwise kept as it is. */
export function indexCommentChange(
  table: QualifiedName,
  old: Commented,
  current: Commented,
): Changes {
  return commentChange({
    on: "INDEX",
    object: objectName(table, current.name),
    name: qualified(table.schema, current.name),
    before: old.comment,
    after: current.comment,
  });
}
