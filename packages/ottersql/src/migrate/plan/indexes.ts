import type { Index, Table } from "../../catalog/index.ts";
import { combine, manual, objectName, only, outsideStep, step } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { indexComment, indexCommentChange } from "./comments.ts";
import { matchDefinitions } from "./match.ts";
import {
  createIndex,
  dropIndexStatement,
  exceedsNameLimit,
  nameTooLongReason,
  temporaryName,
  identifier,
  qualified,
} from "./sql-text.ts";

/**
 * Indexes are built and dropped concurrently, which lets writes go on. A new index helps the new
 * app, so it is built before the deploy; one the old app may need is dropped after. An index that
 * changed under the same name is built anew under a temporary name after the deploy, then takes
 * the old one's place, so queries never go without it.
 */
export function indexChanges(before: Table, after: Table): Changes {
  const { added, removed, redefined, recommented } = matchDefinitions(
    before.indexes,
    after.indexes,
  );
  return combine([
    // Built concurrently in a step of its own, so its comment follows in another.
    ...added.flatMap((index) => [
      buildIndex(after, index, "expand"),
      indexCommentChange(after, { name: index.name, comment: null }, index),
    ]),
    ...removed.map((index) => dropIndex(after, index)),
    ...redefined.map(([old, current]) => rebuildIndex(after, old, current)),
    ...recommented.map(([old, current]) => indexCommentChange(after, old, current)),
  ]);
}

function rebuildIndex(table: Table, old: Index, current: Index): Changes {
  const temporary = temporaryName("new", current.name);
  if (exceedsNameLimit(temporary)) {
    return manual(
      objectName(table, current.name),
      nameTooLongReason(`The temporary index "${temporary}"`, "rebuild the index"),
    );
  }
  const rename = step({
    kind: "renameIndex",
    object: objectName(table, current.name),
    statements: [
      `ALTER INDEX ${qualified(table.schema, temporary)} RENAME TO ${identifier(current.name)}`,
      ...indexComment(table, current),
    ],
    phase: "contract",
    reversal: "reversible",
    lock: "share update exclusive",
  });
  return combine([
    buildIndex(table, { ...current, name: temporary }, "contract"),
    dropIndex(table, old),
    only(rename),
  ]);
}

function buildIndex(table: Table, index: Index, phase: "expand" | "contract"): Changes {
  return only(
    outsideStep({
      kind: "createIndex",
      object: objectName(table, index.name),
      statements: [createIndex(table, index, true)],
      cleanup: { schema: table.schema, name: index.name },
      phase,
      reversal: "reversible",
      lock: "share update exclusive",
    }),
  );
}

function dropIndex(table: Table, index: Index): Changes {
  return only(
    outsideStep({
      kind: "dropIndex",
      object: objectName(table, index.name),
      statements: [dropIndexStatement({ schema: table.schema, name: index.name })],
      cleanup: null,
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
    }),
  );
}
