const SECOND = 1000;
const STAMP_LENGTH = "YYYYMMDDHHMMSS".length;
const labelPattern = "[0-9a-z]+(?:_[0-9a-z]+)*";
const label = new RegExp(`^${labelPattern}$`, "v");
const fileName = new RegExp(
  `^(?<year>\\d{4})(?<month>\\d{2})(?<day>\\d{2})(?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})_${labelPattern}\\.sql$`,
  "v",
);

/** What a migration file's name must be, for messages. */
export const migrationNameRule =
  "the name must be YYYYMMDDHHMMSS_<name>.sql, the time in UTC and the name in lowercase letters, digits and underscores";

/**
 * Why `name` cannot follow the time in a migration's file name, as `add_users` can, or `null`
 * when it can.
 */
export function migrationLabelProblem(name: string): string | null {
  return label.test(name)
    ? null
    : `A migration name is lowercase letters, digits and underscores, not ${JSON.stringify(name)}`;
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
  const problem = migrationLabelProblem(name);
  if (problem !== null) {
    throw new RangeError(problem);
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
