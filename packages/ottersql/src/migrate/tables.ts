import { isDeepStrictEqual } from "node:util";

import type { Catalog, ForeignKey, Table } from "../catalog/index.ts";
import { changeTable } from "./changed-tables.ts";
import type { Sides } from "./changed-tables.ts";
import { dropConstraint } from "./constraints.ts";
import { matchByQualifiedName } from "./match.ts";
import { newTable } from "./new-tables.ts";
import { qualified } from "./sql-text.ts";
import { combine, manual, objectName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";
import { inHierarchy } from "./table-hierarchies.ts";

/** Changes to tables in no hierarchy on either side; table-hierarchies.ts lists those. */
export function tableChanges(sides: Sides): Changes {
  const { from, to } = sides;
  const hierarchical = inHierarchy(from, to);
  const plain = (catalog: Catalog): Table[] =>
    catalog.tables.filter((table) => !hierarchical(table));
  const { added, removed, kept } = matchByQualifiedName(plain(from), plain(to));
  const created = added.filter((table) => !removed.some((old) => sameColumns(old, table)));
  return combine([
    ...created.map((table) => newTable(table, from, sides.unplanned)),
    ...removed.map((table) => {
      const other = added.find((candidate) => sameColumns(candidate, table));
      return other === undefined ? dropTable(table, removed) : maybeRenamedTable(table, other);
    }),
    ...kept.map(([before, after]) => changeTable(before, after, sides)),
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
  const object = objectName(dropped);
  return manual(
    object,
    `${object} is dropped and ${objectName(created)} with the same columns is created, which may be a rename that would lose the table's data; write it by hand: RENAME for a rename, or DROP TABLE and CREATE TABLE otherwise`,
  );
}

/**
 * A table's foreign keys to other tables dropped with it go first, so the tables can be dropped in
 * any order, even when they reference each other.
 */
function dropTable(table: Table, dropped: readonly Table[]): Changes {
  const alsoDropped = (key: ForeignKey): boolean =>
    dropped.some(
      (other) =>
        other !== table &&
        other.schema === key.references.schema &&
        other.name === key.references.table,
    );
  const dropKey = (key: ForeignKey): Changes =>
    dropConstraint(table, key.name, { kind: "dropForeignKey", phase: "contract" });
  const dropKeys = table.foreignKeys.filter((key) => alsoDropped(key)).map((key) => dropKey(key));
  const drop = step({
    kind: "dropTable",
    object: objectName(table),
    statements: [`DROP TABLE ${qualified(table.schema, table.name)}`],
    phase: "contract",
    reversal: "irreversible",
    lock: "access exclusive",
  });
  return combine([...dropKeys, only(drop)]);
}
