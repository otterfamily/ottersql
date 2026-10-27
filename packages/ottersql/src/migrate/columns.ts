import { isDeepStrictEqual } from "node:util";

import { findDomain } from "../catalog/find.ts";
import type { Catalog, Column, Domain, Table, TypeRef } from "../catalog/index.ts";
import { typeChange } from "./column-types.ts";
import type { ColumnChange } from "./column-types.ts";
import { commentChange } from "./comments.ts";
import {
  alterTable,
  columnDefinition,
  columnSqlName,
  exceedsNameLimit,
  identifier,
  setStorage,
} from "./sql-text.ts";
import {
  combine,
  manual,
  matchByName,
  noChanges,
  notPlanned,
  objectName,
  only,
  step,
} from "./steps.ts";
import type { Changes } from "./steps.ts";
import { unplannedUse, usesUnplanned } from "./unplanned-uses.ts";

/**
 * The changes from `before` to `after`, a table of the catalog `to`; `unplanned` is what the plan
 * leaves to a person, which a new column cannot use until it exists.
 */
export function columnChanges(
  before: Table,
  after: Table,
  { to, unplanned }: { readonly to: Catalog; readonly unplanned: ReadonlySet<string> },
): Changes {
  const { added, removed, kept } = matchByName(before.columns, after.columns);
  const renamed = (column: Column): Column | undefined =>
    added.find((other) => other.typeSql === column.typeSql);
  const suspects = removed.filter((column) => renamed(column) !== undefined);
  const add = (column: Column): Changes => {
    const used = unplannedUse([column], unplanned);
    return used === null
      ? addColumn(after, column, to)
      : usesUnplanned(objectName(after, column.name), used, "add the column");
  };
  return combine([
    ...added
      .filter((column) => !suspects.some((suspect) => renamed(suspect) === column))
      .map((column) => add(column)),
    ...removed.map((column) => {
      const other = renamed(column);
      return other === undefined
        ? dropColumn(after, column)
        : maybeRenamedColumn(after, column, other);
    }),
    ...kept.map(([old, current]) =>
      changeColumn({ table: after, before: old, after: current }, to),
    ),
  ]);
}

/** The domains `type` is built on, nearest first: its domain, the domain that one is over, and so on. */
function domainsOf(catalog: Catalog, type: TypeRef): Domain[] {
  const domain = type.kind === "domain" ? findDomain(catalog, type.schema, type.name) : undefined;
  return domain === undefined ? [] : [domain, ...domainsOf(catalog, domain.baseType)];
}

/**
 * Why adding `column`, of the catalog `to`, to a table with rows would rewrite every row, or
 * `null` when it would not.
 */
function rewriteReason(column: Column, to: Catalog): string | null {
  return (
    valueRewriteReason(column.value) ?? domainRewriteReason(column, domainsOf(to, column.type))
  );
}

function valueRewriteReason(value: Column["value"]): string | null {
  if (value.kind === "generated" && value.storage === "stored") {
    return "Adding a stored generated column rewrites the table under an exclusive lock; add a virtual one, or add a plain column, backfill it in batches and fill it with a trigger";
  }
  if (value.kind === "identity") {
    return "Adding an identity column rewrites the table under an exclusive lock to number every row; add a nullable column, backfill it in batches, then make it an identity";
  }
  if (value.kind === "sequence") {
    return "Adding a serial column rewrites the table under an exclusive lock to number every row; add a nullable column, backfill it in batches, then set its default to the sequence";
  }
  if (value.kind === "default" && value.volatile) {
    return "A volatile default is computed for every existing row, which rewrites the table under an exclusive lock; add the column without a default, set the default, and backfill in batches";
  }
  return null;
}

/** Postgres checks a constrained domain on every existing row, and fills in a volatile domain default for each. */
function domainRewriteReason(column: Column, domains: readonly Domain[]): string | null {
  if (domains.some((domain) => domain.notNull || domain.checks.length > 0)) {
    return "A column of a domain with a CHECK or NOT NULL is checked row by row, which rewrites the table under an exclusive lock; use the base type with a CHECK constraint instead, which is validated without blocking writes";
  }
  const domainDefault = domains.find((domain) => domain.default !== null)?.default;
  if (column.value.kind === "none" && domainDefault?.volatile === true) {
    return "The domain's default is volatile, so it is computed for every existing row, which rewrites the table under an exclusive lock; add the column with DEFAULT NULL, which overrides it, then drop that default and backfill in batches";
  }
  return null;
}

/**
 * A column is added in one step when that rewrites no rows. A NOT NULL column without a default
 * is added as nullable and made NOT NULL after the deploy, once the app fills it; existing rows
 * must be filled before then.
 */
function addColumn(table: Table, column: Column, to: Catalog): Changes {
  const object = objectName(table, column.name);
  const reason = rewriteReason(column, to);
  if (reason !== null) {
    return manual(object, reason);
  }
  const deferNotNull = column.notNull && column.value.kind === "none";
  const definition = columnDefinition(deferNotNull ? { ...column, notNull: false } : column);
  const add = step({
    kind: "addColumn",
    object,
    statements: [alterTable(table, [`ADD COLUMN ${definition}`, ...setStorage(column)].join(", "))],
    phase: "expand",
    reversal: "lossy",
    lock: "access exclusive",
  });
  return combine([
    only(add),
    deferNotNull ? setNotNull(table, column) : noChanges,
    commentChange({
      on: "COLUMN",
      object,
      name: columnSqlName(table, column.name),
      before: null,
      after: column.comment,
    }),
  ]);
}

function maybeRenamedColumn(table: Table, dropped: Column, added: Column): Changes {
  const object = objectName(table, dropped.name);
  return manual(
    object,
    `${object} is dropped and ${objectName(table, added.name)} of the same type is added, which may be a rename that would lose the column's data; write it by hand: RENAME COLUMN for a rename (or add, backfill and switch, to keep the old app working), or DROP COLUMN and ADD COLUMN otherwise`,
  );
}

function dropColumn(table: Table, column: Column): Changes {
  const statement = alterTable(table, `DROP COLUMN ${identifier(column.name)}`);
  return only(
    step({
      kind: "dropColumn",
      object: objectName(table, column.name),
      statements: [statement],
      phase: "contract",
      reversal: "irreversible",
      lock: "access exclusive",
    }),
  );
}

function changeColumn(change: ColumnChange, to: Catalog): Changes {
  const { table, before, after } = change;
  const type = typeChange(change, to);
  if (type.manual.length > 0) {
    return type;
  }
  if (before.storage !== after.storage || before.compression !== after.compression) {
    return manual(objectName(table, after.name), notPlanned("a column's storage or compression"));
  }
  return combine([
    type,
    valueChange(table, before, after),
    notNullChange(table, before, after),
    commentChange({
      on: "COLUMN",
      object: objectName(table, after.name),
      name: columnSqlName(table, after.name),
      before: before.comment,
      after: after.comment,
    }),
  ]);
}

/** A new default helps the new app, so it is set before the deploy; one the old app relies on is dropped after. */
function valueChange(table: Table, before: Column, after: Column): Changes {
  const old = before.value;
  const current = after.value;
  if (isDeepStrictEqual(old, current)) {
    return noChanges;
  }
  if (current.kind === "default" && (old.kind === "none" || old.kind === "default")) {
    return defaultChange(table, after.name, `SET DEFAULT ${current.expression}`);
  }
  if (current.kind === "none" && old.kind === "default") {
    return defaultChange(table, after.name, "DROP DEFAULT");
  }
  return manual(
    objectName(table, after.name),
    "ottersql does not plan changes to serial, identity or generated columns yet",
  );
}

function defaultChange(
  table: Table,
  column: string,
  action: `SET DEFAULT ${string}` | "DROP DEFAULT",
): Changes {
  const set = action !== "DROP DEFAULT";
  const statement = alterTable(table, `ALTER COLUMN ${identifier(column)} ${action}`);
  return only(
    step({
      kind: set ? "setDefault" : "dropDefault",
      object: objectName(table, column),
      statements: [statement],
      phase: set ? "expand" : "contract",
      reversal: "reversible",
      lock: "access exclusive",
    }),
  );
}

function notNullChange(table: Table, before: Column, after: Column): Changes {
  if (before.notNull === after.notNull && before.notNullNoInherit === after.notNullNoInherit) {
    return noChanges;
  }
  if (before.notNullNoInherit || after.notNullNoInherit) {
    return manual(objectName(table, after.name), notPlanned("NOT NULL NO INHERIT"));
  }
  if (after.notNull) {
    return setNotNull(table, after);
  }
  const statement = alterTable(table, `ALTER COLUMN ${identifier(after.name)} DROP NOT NULL`);
  return only(
    step({
      kind: "dropNotNull",
      object: objectName(table, after.name),
      statements: [statement],
      phase: "expand",
      reversal: "lossy",
      lock: "access exclusive",
    }),
  );
}

/**
 * `SET NOT NULL` alone scans the table under an exclusive lock. A validated `IS NOT NULL` check
 * proves the same without blocking writes, and Postgres then sets NOT NULL without scanning.
 */
function setNotNull(table: Table, column: Column): Changes {
  const check = `ottersql_not_null_${column.name}`;
  if (exceedsNameLimit(check)) {
    return manual(
      objectName(table, column.name),
      `The helper check "${check}" would be longer than Postgres's 63-byte names; make the column NOT NULL by hand`,
    );
  }
  const name = identifier(check);
  const columnName = identifier(column.name);
  const checkObject = objectName(table, check);
  const contract = { phase: "contract", reversal: "reversible" } as const;
  return only(
    step({
      ...contract,
      kind: "addCheck",
      object: checkObject,
      statements: [
        alterTable(table, `ADD CONSTRAINT ${name} CHECK (${columnName} IS NOT NULL) NOT VALID`),
      ],
      lock: "access exclusive",
      reason: "Holds for new rows at once, without scanning the table",
    }),
    step({
      ...contract,
      kind: "validateCheck",
      object: checkObject,
      statements: [alterTable(table, `VALIDATE CONSTRAINT ${name}`)],
      lock: "share update exclusive",
      reason:
        "Checking existing rows takes a lock that lets reads and writes go on; existing nulls must be filled first",
    }),
    step({
      ...contract,
      kind: "setNotNull",
      object: objectName(table, column.name),
      statements: [
        alterTable(table, `ALTER COLUMN ${columnName} SET NOT NULL`),
        alterTable(table, `DROP CONSTRAINT ${name}`),
      ],
      lock: "access exclusive",
      reason: "The validated check spares Postgres the scan",
    }),
  );
}
