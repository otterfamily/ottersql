/**
 * Looks up the value Postgres encodes as `code`, for example a one-letter catalog value. Throws on
 * a code the table does not know, so a new Postgres code fails loudly instead of being guessed.
 */
export function decode<Value>(
  table: Readonly<Record<string, Value>>,
  code: string,
  what: string,
): Value {
  const value = Object.hasOwn(table, code) ? table[code] : undefined;
  if (value === undefined) {
    throw new Error(`unknown ${what} ${JSON.stringify(code)}`);
  }
  return value;
}
