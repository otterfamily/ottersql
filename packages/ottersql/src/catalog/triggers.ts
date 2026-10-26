import { boolean, fields, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";

export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

/** A trigger the schema declares on a table; Postgres's internal ones, such as foreign keys', are left out. */
export interface Trigger {
  readonly name: string;
  readonly timing: "before" | "after" | "instead of";
  readonly events: readonly TriggerEvent[];
  /** FOR EACH ROW, rather than once per statement. */
  readonly forEachRow: boolean;
  /** The CREATE TRIGGER statement as Postgres prints it. */
  readonly definition: string;
}

export interface TriggerRow {
  readonly name: string;
  readonly definition: string;
  readonly forEachRow: boolean;
  readonly before: boolean;
  readonly insteadOf: boolean;
  readonly insert: boolean;
  readonly delete: boolean;
  readonly update: boolean;
  readonly truncate: boolean;
}

/**
 * Selects the triggers of the table `relationOid` that its schema declares, as `parseTrigger` reads
 * them, from the bits of pg_trigger.tgtype that Postgres's pg_trigger.h defines.
 */
export function triggersJson(relationOid: string): string {
  return `coalesce((
    select json_agg(json_build_object(
      'name', trigger_row.tgname,
      'definition', pg_get_triggerdef(trigger_row.oid),
      'forEachRow', trigger_row.tgtype & 1 <> 0,
      'before', trigger_row.tgtype & 2 <> 0,
      'insert', trigger_row.tgtype & 4 <> 0,
      'delete', trigger_row.tgtype & 8 <> 0,
      'update', trigger_row.tgtype & 16 <> 0,
      'truncate', trigger_row.tgtype & 32 <> 0,
      'insteadOf', trigger_row.tgtype & 64 <> 0
    ) order by trigger_row.tgname)
    from pg_trigger trigger_row
    where trigger_row.tgrelid = ${relationOid} and not trigger_row.tgisinternal
  ), '[]')`;
}

export const triggerRow: Shape<TriggerRow> = (value, path) => {
  const field = fields(value, path);
  return {
    name: field("name", string),
    definition: field("definition", string),
    forEachRow: field("forEachRow", boolean),
    before: field("before", boolean),
    insteadOf: field("insteadOf", boolean),
    insert: field("insert", boolean),
    delete: field("delete", boolean),
    update: field("update", boolean),
    truncate: field("truncate", boolean),
  };
};

const events: readonly TriggerEvent[] = ["insert", "update", "delete", "truncate"];

function timingOf(row: TriggerRow): Trigger["timing"] {
  if (row.insteadOf) {
    return "instead of";
  }
  return row.before ? "before" : "after";
}

export function parseTrigger(row: TriggerRow): Trigger {
  return {
    name: row.name,
    timing: timingOf(row),
    events: events.filter((event) => row[event]),
    forEachRow: row.forEachRow,
    definition: row.definition,
  };
}
