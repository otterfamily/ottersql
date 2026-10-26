import type { Comment } from "../catalog/index.ts";
import type { Lock } from "./plan.ts";
import { literal } from "./sql-text.ts";
import { noChanges, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

/** `COMMENT ON` takes a SHARE UPDATE EXCLUSIVE lock on a table, and none on a type. */
const commentLocks: Readonly<Record<"TABLE" | "COLUMN" | "TYPE", Lock>> = {
  TABLE: "share update exclusive",
  COLUMN: "share update exclusive",
  TYPE: "none",
};

export function commentChange(target: {
  readonly on: "TABLE" | "COLUMN" | "TYPE";
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
