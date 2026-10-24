const SECOND = 1000;
const STAMP_LENGTH = "YYYYMMDDHHMMSS".length;
const label = /^[0-9a-z]+(?:_[0-9a-z]+)*$/v;
const fileName =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})_[0-9a-z]+(?:_[0-9a-z]+)*\.sql$/v;

/** What a migration file's name must be, for messages. */
export const migrationNameRule =
  "the name must be YYYYMMDDHHMMSS_<name>.sql, the time in UTC and the name in lowercase letters, digits and underscores";

/** Whether `name` can follow the time in a migration's file name, such as `add_users`. */
export function isMigrationLabel(name: string): boolean {
  return label.test(name);
}

export function isMigrationFileName(name: string): boolean {
  return fileName.test(name);
}

/**
 * The file name for a new migration called `name`, such as `20261025123456_add_users.sql`: made
 * now, or a second after the newest of `existing`, so the new file sorts last even when made twice
 * in a second or on a clock behind the one that made the newest.
 */
export function nextMigrationName(existing: readonly string[], name: string, now: Date): string {
  if (!isMigrationLabel(name)) {
    throw new RangeError(
      `A migration name is lowercase letters, digits and underscores, not ${JSON.stringify(name)}`,
    );
  }
  const newest = existing
    .filter((file) => isMigrationFileName(file))
    .toSorted()
    .at(-1);
  const after = newest === undefined ? now.getTime() : madeAt(newest) + SECOND;
  const stamp = new Date(Math.max(now.getTime(), after))
    .toISOString()
    .replaceAll(/\D/gv, "")
    .slice(0, STAMP_LENGTH);
  return `${stamp}_${name}.sql`;
}

/** The time a valid migration file name starts with. */
function madeAt(name: string): number {
  return Date.parse(name.replace(fileName, "$<year>-$<month>-$<day>T$<hour>:$<minute>:$<second>Z"));
}
