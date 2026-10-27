import type { Comment, QualifiedName } from "../../catalog/index.ts";
import type { Lock } from "../plan.ts";
import { noChanges, objectName, only, step } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { identifier, literal, qualified } from "./sql-text.ts";

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
  return only(
    step({
      kind: "comment",
      object,
      statements: [commentStatement(on, name, after)],
      phase: "expand",
      reversal: "reversible",
      lock: commentLocks[on],
    }),
  );
}

/** `COMMENT ON` the object SQL names `name`, setting `comment`, or removing it for `null`. */
function commentStatement(on: Commentable, name: string, comment: Comment | null): string {
  return `COMMENT ON ${on} ${name} IS ${comment === null ? "NULL" : literal(comment.text)}`;
}

/** The statement that gives a new object its comment, or none for one without a comment. */
export function initialComment(on: Commentable, name: string, comment: Comment | null): string[] {
  return comment === null ? [] : [commentStatement(on, name, comment)];
}

interface Commented {
  readonly name: string;
  readonly comment: Comment | null;
}

function constraintSqlName(table: QualifiedName, constraint: string): string {
  return `${identifier(constraint)} ON ${qualified(table.schema, table.name)}`;
}

/** An index is in its table's schema. */
function indexSqlName(table: QualifiedName, index: string): string {
  return qualified(table.schema, index);
}

/** The statement that comments a new constraint of `table`, or none for one without a comment. */
export function constraintComment(table: QualifiedName, constraint: Commented): string[] {
  return initialComment(
    "CONSTRAINT",
    constraintSqlName(table, constraint.name),
    constraint.comment,
  );
}

/** The statement that comments a new index of `table`, or none for one without a comment. */
export function indexComment(table: QualifiedName, index: Commented): string[] {
  return initialComment("INDEX", indexSqlName(table, index.name), index.comment);
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
    name: constraintSqlName(table, current.name),
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
    name: indexSqlName(table, current.name),
    before: old.comment,
    after: current.comment,
  });
}
