import type { Catalog, Schema } from "../../catalog/index.ts";
import { combine, objectName, only, step } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { commentChange } from "./comments.ts";
import { matchByName } from "./match.ts";
import { identifier } from "./sql-text.ts";

/**
 * A new schema is created first, so the objects in it can be; a removed one is dropped last, once
 * they are gone. DROP SCHEMA without CASCADE fails while anything is left in it, rather than
 * taking with it objects the plan does not list.
 */
export function schemaChanges(from: Catalog, to: Catalog): Changes {
  const { added, removed, kept } = matchByName(from.schemas, to.schemas);
  return combine([
    ...added.map((schema) => createSchema(schema)),
    ...removed.map((schema) => dropSchema(schema)),
    ...kept.map(([before, after]) => comment(before.comment, after)),
  ]);
}

function createSchema(schema: Schema): Changes {
  const create = step({
    kind: "createSchema",
    object: objectName(schema.name),
    statements: [`CREATE SCHEMA ${identifier(schema.name)}`],
    phase: "expand",
    reversal: "reversible",
    lock: "none",
  });
  return combine([only(create), comment(null, schema)]);
}

function dropSchema(schema: Schema): Changes {
  return only(
    step({
      kind: "dropSchema",
      object: objectName(schema.name),
      statements: [`DROP SCHEMA ${identifier(schema.name)}`],
      phase: "contract",
      reversal: "irreversible",
      lock: "none",
    }),
  );
}

function comment(before: Schema["comment"], after: Schema): Changes {
  return commentChange({
    on: "SCHEMA",
    object: objectName(after.name),
    name: identifier(after.name),
    before,
    after: after.comment,
  });
}
