import { isDeepStrictEqual } from "node:util";

import type { Catalog, ForeignKey, Index, Table } from "../catalog/index.ts";
import { columnChanges } from "./columns.ts";
import { commentChange } from "./comments.ts";
import { constraintChanges, dropConstraint } from "./constraints.ts";
import { newTable } from "./new-tables.ts";
import {
  createIndex,
  dropIndexStatement,
  exceedsNameLimit,
  identifier,
  qualified,
} from "./sql-text.ts";
import {
  combine,
  manual,
  matchByName,
  noChanges,
  notPlanned,
  objectName,
  only,
  outsideStep,
  step,
} from "./steps.ts";
import type { Changes } from "./steps.ts";
import { hierarchyTables } from "./table-hierarchies.ts";
import { uniqueChanges } from "./unique-keys.ts";

function withKey(tables: readonly Table[]): { readonly name: string; readonly table: Table }[] {
  return tables.map((table) => ({ name: `${table.schema}.${table.name}`, table }));
}

/** The catalogs a plan goes between, and what it leaves to a person that new objects may use. */
interface Sides {
  readonly from: Catalog;
  readonly to: Catalog;
  readonly unplanned: ReadonlySet<string>;
}

/** Changes to tables in no hierarchy on either side; table-hierarchies.ts lists those. */
export function tableChanges(sides: Sides): Changes {
  const { from, to } = sides;
  const inHierarchy = hierarchyTables(from, to);
  const plain = (catalog: Catalog): { readonly name: string; readonly table: Table }[] =>
    withKey(catalog.tables).filter(({ name }) => !inHierarchy.has(name));
  const { added, removed, kept } = matchByName(plain(from), plain(to));
  const created = added.filter(
    ({ table }) => !removed.some((old) => sameColumns(old.table, table)),
  );
  return combine([
    ...created.map(({ table }) => newTable(table, from, sides.unplanned)),
    ...removed.map(({ table }) => {
      const other = added.find((candidate) => sameColumns(candidate.table, table));
      return other === undefined
        ? dropTable(table, removed)
        : maybeRenamedTable(table, other.table);
    }),
    ...kept.map(([before, after]) => changeTable(before.table, after.table, sides)),
  ]);
}

/** Whether two tables have the same columns, by name and type, so one may be the other renamed. */
function sameColumns(left: Table, right: Table): boolean {
  return isDeepStrictEqual(columnTypes(left), columnTypes(right));
}

function columnTypes(table: Table): string[] {
  return table.columns.map(({ name, typeSql }) => `${name} ${typeSql}`).toSorted();
}

function maybeRenamedTable(dropped: Table, created: Table): Changes {
  const object = `${dropped.schema}.${dropped.name}`;
  return manual(
    object,
    `${object} is dropped and ${created.schema}.${created.name} with the same columns is created, which may be a rename that would lose the table's data; write it by hand: RENAME for a rename, or DROP TABLE and CREATE TABLE otherwise`,
  );
}

/**
 * A table's foreign keys to other tables dropped with it go first, so the tables can be dropped in
 * any order, even when they reference each other.
 */
function dropTable(
  table: Table,
  dropped: readonly { readonly name: string; readonly table: Table }[],
): Changes {
  const alsoDropped = (key: ForeignKey): boolean =>
    dropped.some(
      ({ table: other }) =>
        other !== table &&
        other.schema === key.references.schema &&
        other.name === key.references.table,
    );
  const dropKey = (key: ForeignKey): Changes =>
    dropConstraint(table, key.name, { kind: "dropForeignKey", phase: "contract" });
  const dropKeys = table.foreignKeys.filter((key) => alsoDropped(key)).map((key) => dropKey(key));
  const drop = step({
    kind: "dropTable",
    object: `${table.schema}.${table.name}`,
    statements: [`DROP TABLE ${qualified(table.schema, table.name)}`],
    phase: "contract",
    reversal: "irreversible",
    lock: "access exclusive",
  });
  return combine([...dropKeys, only(drop)]);
}

/** The changes from `before`, a table of the catalog `from`, to `after`, one of `to`. */
function changeTable(before: Table, after: Table, { from, to, unplanned }: Sides): Changes {
  const storageChanged =
    before.unlogged !== after.unlogged || !isDeepStrictEqual(before.options, after.options);
  return combine([
    storageChanged
      ? manual(
          `${after.schema}.${after.name}`,
          notPlanned("whether a table is logged, or to its storage parameters,"),
        )
      : noChanges,
    columnChanges(before, after, { to, unplanned }),
    constraintChanges(before, after),
    uniqueChanges(before, after, from),
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
 * changed under the same name is built anew under a temporary name after the deploy, then takes
 * the old one's place, so queries never go without it.
 */
function indexChanges(before: Table, after: Table): Changes {
  const { added, removed, kept } = matchByName(before.indexes, after.indexes);
  const changed = kept.filter(([old, current]) => !isDeepStrictEqual(old, current));
  return combine([
    ...added.map((index) => buildIndex(after, index, "expand")),
    ...removed.map((index) => dropIndex(after, index)),
    ...changed.map(([old, current]) => rebuildIndex(after, old, current)),
  ]);
}

function rebuildIndex(table: Table, old: Index, current: Index): Changes {
  const temporary = `ottersql_new_${current.name}`;
  if (exceedsNameLimit(temporary)) {
    return manual(
      objectName(table, current.name),
      `The temporary index "${temporary}" would be longer than Postgres's 63-byte names; rebuild the index by hand`,
    );
  }
  const rename = step({
    kind: "renameIndex",
    object: objectName(table, current.name),
    statements: [
      `ALTER INDEX ${qualified(table.schema, temporary)} RENAME TO ${identifier(current.name)}`,
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
      statements: [dropIndexStatement(table, index.name)],
      cleanup: null,
      phase: "contract",
      reversal: "reversible",
      lock: "share update exclusive",
    }),
  );
}
