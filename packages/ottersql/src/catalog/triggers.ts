import { boolean, fields, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import type { Trigger, TriggerEvent } from "./model.ts";

export interface TriggerRow {
  readonly name: string;
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
  };
}
