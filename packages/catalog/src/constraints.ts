import { columnNames } from "./columns.ts";
import type {
  Deferral,
  Enforcement,
  ForeignKey,
  ForeignKeyAction,
  PrimaryKey,
  UniqueConstraint,
} from "./model.ts";

/** Selects the constraints of the table whose `pg_class` row is aliased `alias`, as `parseConstraints` reads them. */
export function constraintsJson(alias: string): string {
  return `
    (select json_build_object('name', con.conname, 'columns', ${columnNames("con.conrelid", "con.conkey")})
     from pg_constraint con where con.conrelid = ${alias}.oid and con.contype = 'p') as "primaryKey",
    coalesce((
      select json_agg(json_build_object(
        'name', con.conname,
        'columns', ${columnNames("con.conrelid", "con.conkey")},
        'nullsNotDistinct', i.indnullsnotdistinct,
        'deferrable', con.condeferrable,
        'deferred', con.condeferred
      ) order by con.conname)
      from pg_constraint con join pg_index i on i.indexrelid = con.conindid
      where con.conrelid = ${alias}.oid and con.contype = 'u'
    ), '[]') as "uniqueConstraints",
    coalesce((
      select json_agg(json_build_object(
        'name', con.conname,
        'columns', ${columnNames("con.conrelid", "con.conkey")},
        'referencedSchema', rn.nspname,
        'referencedTable', r.relname,
        'referencedColumns', ${columnNames("con.confrelid", "con.confkey")},
        'match', con.confmatchtype,
        'onUpdate', con.confupdtype,
        'onDelete', con.confdeltype,
        'deferrable', con.condeferrable,
        'deferred', con.condeferred,
        'validated', con.convalidated,
        'enforced', con.conenforced
      ) order by con.conname)
      from pg_constraint con
      join pg_class r on r.oid = con.confrelid
      join pg_namespace rn on rn.oid = r.relnamespace
      where con.conrelid = ${alias}.oid and con.contype = 'f'
    ), '[]') as "foreignKeys"`;
}

export interface ConstraintRows {
  readonly primaryKey: PrimaryKey | null;
  readonly uniqueConstraints: readonly UniqueRow[];
  readonly foreignKeys: readonly ForeignKeyRow[];
}

interface DeferralRow {
  readonly deferrable: boolean;
  readonly deferred: boolean;
}

interface UniqueRow extends DeferralRow {
  readonly name: string;
  readonly columns: readonly string[];
  readonly nullsNotDistinct: boolean;
}

interface ForeignKeyRow extends DeferralRow {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedSchema: string;
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly match: string;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly validated: boolean;
  readonly enforced: boolean;
}

export function parseConstraints(rows: ConstraintRows): {
  primaryKey: PrimaryKey | null;
  uniqueConstraints: UniqueConstraint[];
  foreignKeys: ForeignKey[];
} {
  return {
    primaryKey: rows.primaryKey,
    uniqueConstraints: rows.uniqueConstraints.map((row) => ({
      name: row.name,
      columns: row.columns,
      nullsNotDistinct: row.nullsNotDistinct,
      deferral: parseDeferral(row),
    })),
    foreignKeys: rows.foreignKeys.map((row) => ({
      name: row.name,
      columns: row.columns,
      references: {
        schema: row.referencedSchema,
        table: row.referencedTable,
        columns: row.referencedColumns,
      },
      match: parseMatch(row.match),
      onUpdate: parseAction(row.onUpdate),
      onDelete: parseAction(row.onDelete),
      deferral: parseDeferral(row),
      enforcement: parseEnforcement(row),
    })),
  };
}

function parseDeferral(row: DeferralRow): Deferral {
  if (!row.deferrable) {
    return "not deferrable";
  }
  return row.deferred ? "initially deferred" : "initially immediate";
}

export function parseEnforcement(row: {
  readonly validated: boolean;
  readonly enforced: boolean;
}): Enforcement {
  if (!row.enforced) {
    return "not enforced";
  }
  return row.validated ? "validated" : "not valid";
}

function parseMatch(code: string): ForeignKey["match"] {
  switch (code) {
    case "s": {
      return "simple";
    }
    case "f": {
      return "full";
    }
    case "p": {
      return "partial";
    }
    default: {
      throw new Error(`unknown pg_constraint.confmatchtype ${JSON.stringify(code)}`);
    }
  }
}

function parseAction(code: string): ForeignKeyAction {
  switch (code) {
    case "a": {
      return "no action";
    }
    case "r": {
      return "restrict";
    }
    case "c": {
      return "cascade";
    }
    case "n": {
      return "set null";
    }
    case "d": {
      return "set default";
    }
    default: {
      throw new Error(`unknown foreign key action ${JSON.stringify(code)}`);
    }
  }
}
