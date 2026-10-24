import { isDeepStrictEqual } from "node:util";

import type { Catalog, Index, Table } from "@ottersql/catalog";

import { columnChanges } from "./columns.ts";
import { commentChange } from "./comments.ts";
import { constraintChanges, inlineConstraints, newTableConstraints } from "./constraints.ts";
import { columnDefinition, createIndex, literal, qualified } from "./sql-text.ts";
import { combine, matchByName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { columnSqlName, dropIndexStatement, objectName } from "./table-sql.ts";

function withKey(tables: readonly Table[]): { readonly name: string; readonly table: Table }[] {
  return tables.map((table) => ({ name: `${table.schema}.${table.name}`, table }));
}

export function tableChanges(from: Catalog, to: Catalog): Changes {
  const { added, removed, kept } = matchByName(withKey(from.tables), withKey(to.tables));
  return combine([
    ...added.map(({ table }) => createTable(table)),
    ...added.map(({ table }) => newTableConstraints(table)),
    ...removed.map(({ table }) => dropTable(table)),
    ...kept.map(([before, after]) => changeTable(before.table, after.table)),
  ]);
}

function comments(table: Table): string[] {
  const name = qualified(table.schema, table.name);
  return [
    ...(table.comment === null
      ? []
      : [`COMMENT ON TABLE ${name} IS ${literal(table.comment.text)}`]),
    ...table.columns.flatMap((column) =>
      column.comment === null
        ? []
        : [
            `COMMENT ON COLUMN ${columnSqlName(table, column.name)} IS ${literal(column.comment.text)}`,
          ],
    ),
  ];
}

/** A new table has no rows and no app using it yet, so it is created whole, indexes included. */
function createTable(table: Table): Changes {
  const definitions = [
    ...table.columns.map((column) => columnDefinition(column)),
    ...inlineConstraints(table),
  ];
  return only(
    step({
      kind: "createTable",
      object: `${table.schema}.${table.name}`,
      statements: [
        `CREATE TABLE ${qualified(table.schema, table.name)} (${definitions.join(", ")})`,
        ...table.indexes.map((index) => createIndex(table, index, false)),
        ...comments(table),
      ],
      phase: "expand",
      reversal: "lossy",
      lock: "none",
    }),
  );
}

function dropTable(table: Table): Changes {
  return only(
    step({
      kind: "dropTable",
      object: `${table.schema}.${table.name}`,
      statements: [`DROP TABLE ${qualified(table.schema, table.name)}`],
      phase: "contract",
      reversal: "irreversible",
      lock: "access exclusive",
    }),
  );
}

function changeTable(before: Table, after: Table): Changes {
  return combine([
    columnChanges(before, after),
    constraintChanges(before, after),
    indexChanges(before, after),
    commentChange({
      on: "TABLE",
      object: `${after.schema}.${after.name}`,
      name: qualified(after.schema, after.name),
      before: before.comment,
      after: after.comment,
    }),
  ]);
}

/**
 * Indexes are built and dropped concurrently, which lets writes go on. A new index helps the new
 * app, so it is built before the deploy; one the old app may need is dropped after. An index that
 * changed under the same name is rebuilt after the deploy.
 */
function indexChanges(before: Table, after: Table): Changes {
  const { added, removed, kept } = matchByName(before.indexes, after.indexes);
  const changed = kept.filter(([old, current]) => !isDeepStrictEqual(old, current));
  return combine([
    ...added.map((index) => buildIndex(after, index, "expand")),
    ...[...removed, ...changed.map(([old]) => old)].map((index) => dropIndex(after, index)),
    ...changed.map(([, current]) => buildIndex(after, current, "contract")),
  ]);
}

function buildIndex(table: Table, index: Index, phase: "expand" | "contract"): Changes {
  return only(
    step({
      kind: "createIndex",
      object: objectName(table, index.name),
      statements: [createIndex(table, index, true)],
      cleanup: [dropIndexStatement(table, index.name)],
      phase,
      reversal: "reversible",
      lock: "share update exclusive",
      transaction: "outside",
    }),
  );
}

function dropIndex(table: Table, index: Index): Changes {
  return only(
    step({
      kind: "dropIndex",
      object: objectName(table, index.name),
      statements: [dropIndexStatement(table, index.name)],
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
      transaction: "outside",
    }),
  );
}
