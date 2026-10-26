/** A query returned more or fewer rows than `one` or `maybeOne` takes; none were decoded. */
export class RowCountError extends Error {
  override readonly name = "RowCountError";
  /** How many rows the query returned. */
  readonly count: number;

  constructor(expected: "exactly one" | "at most one", count: number) {
    super(`expected ${expected} row, got ${String(count)}`);
    this.count = count;
  }
}
