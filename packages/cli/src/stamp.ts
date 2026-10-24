const SECOND = 1000;
const STAMP_LENGTH = "YYYYMMDDHHMMSS".length;
const stamped =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})_/v;

/**
 * The `YYYYMMDDHHMMSS` (UTC) that names the next migration: now, or a second after the newest of
 * `names`, so the new file sorts last even when generated twice in a second or on a clock behind
 * the one that named the newest.
 */
export function nextStamp(names: readonly string[], now: Date): string {
  const newest = names.toSorted().at(-1);
  const after = newest === undefined ? null : stampTime(newest);
  const time = after === null ? now.getTime() : Math.max(now.getTime(), after + SECOND);
  return new Date(time).toISOString().replaceAll(/\D/gv, "").slice(0, STAMP_LENGTH);
}

/** When a migration's name says it was made, or `null` for a name that starts with no time. */
function stampTime(name: string): number | null {
  const prefix = stamped.exec(name)?.[0];
  return prefix === undefined
    ? null
    : Date.parse(prefix.replace(stamped, "$<year>-$<month>-$<day>T$<hour>:$<minute>:$<second>Z"));
}
